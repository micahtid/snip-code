/**
 * background.js: mv3 service worker. This is a privileged broker, not a
 * pipeline phase.
 *
 * This is the extension's only privileged context. It exists so the content
 * script (sandboxed, same-origin-limited) can reach things it cannot touch
 * directly: cross-origin stylesheet fetches, tab screenshots, and byok llm
 * provider calls. It routes the extension's message protocol.
 *
 * It wires the toolbar icon to open the side panel and routes the fetch,
 * screenshot, llm, and storage handlers.
 *
 * Security: this worker reads byok keys from chrome.storage.local to attach
 * auth headers, but never logs them and never persists them anywhere else.
 */

// Open the side panel when the toolbar icon is clicked. Requires the
// "sidePanel" permission and a side_panel entry in the manifest.
chrome.runtime.onInstalled.addListener(() => {
	if (chrome.sidePanel) {
		chrome.sidePanel
			.setPanelBehavior({ openPanelOnActionClick: true })
			.catch((err) => console.warn('snipcode: could not set side panel behavior', err));
	}
});

/**
 * Message router. The content script reaches privileged apis
 * only through here. Handlers reply via the Response envelope
 * { requestId, ok, result?, error? }. Returning true keeps the channel open for
 * the async sendResponse.
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	if (!message || typeof message !== 'object') return false;

	switch (message.type) {
		case 'CAPTURE_SCREENSHOT': {
			// Content scripts cannot call captureVisibleTab; the worker can. It
			// returns the whole viewport at device resolution and the content-side
			// picker crops to the element rect (it knows the dpr + scroll offsets).
			chrome.tabs
				.captureVisibleTab({ format: 'png' })
				.then((dataUrl) => sendResponse({ requestId: message.requestId, ok: true, result: { dataUrl } }))
				.catch((err) =>
					sendResponse({
						requestId: message.requestId,
						ok: false,
						error: { code: 'MALFORMED_REQUEST', message: String(err) },
					}),
				);
			return true; // Async response
		}

		case 'CDP_INHERITED': {
			// Read the authored inherited cascade via the devtools protocol. Only
			// the background can attach the debugger. This is a capture-internal
			// message; see capture/cdp.ts for the rationale.
			const tabId = _sender.tab && _sender.tab.id;
			cdpInheritedChain(tabId, message.payload && message.payload.selector)
				.then((result) => sendResponse({ requestId: message.requestId, ok: true, result }))
				.catch((err) =>
					sendResponse({
						requestId: message.requestId,
						ok: false,
						error: { code: 'MALFORMED_REQUEST', message: String(err && err.message ? err.message : err) },
					}),
				);
			return true;
		}

		case 'LLM_REQUEST': {
			// Byok llm calls (polish + the inspect ai passes). The worker reads the
			// key from storage (never logs it), calls the provider, and returns the
			// raw model { text, usage }; each caller parses its own shape. Content
			// scripts cannot reach provider hosts (page csp), so all llm traffic goes
			// through here. The optional payload.max raises the output-token ceiling
			// for the larger schema-synthesis prompt (polish omits it; default 2000).
			const p = message.payload || {};
			llmRequest(p.provider, p.model, p.prompt, p.max)
				.then((result) => sendResponse({ requestId: message.requestId, ok: true, result }))
				.catch((err) => {
					const msg = String(err && err.message ? err.message : err);
					const code = msg === 'NO_KEY_CONFIGURED' ? 'NO_KEY_CONFIGURED' : 'PROVIDER_ERROR_0';
					const response = { requestId: message.requestId, ok: false, error: { code, message: msg } };
					// A failed-but-billed reply (empty/non-json) carries usage; pass it through to be totalled.
					if (err && err.usage) response.usage = err.usage;
					sendResponse(response);
				});
			return true;
		}

		case 'FETCH_STYLESHEET': {
			// Background fetch bypasses cors via the <all_urls> host permission so
			// the content script can recover cross-origin stylesheets.
			fetchStylesheet(message.payload && message.payload.href)
				.then((result) => sendResponse({ requestId: message.requestId, ok: true, result }))
				.catch((err) =>
					sendResponse({
						requestId: message.requestId,
						ok: false,
						error: { code: 'CORS_BLOCKED', message: String(err && err.message ? err.message : err) },
					}),
				);
			return true;
		}

		default:
			return false;
	}
});

/**
 * Reads the authored inherited cascade for one node via the chrome devtools
 * protocol, with closed shadow roots pierced.
 *
 * Flow: attach debugger -> enable DOM+CSS -> DOM.getDocument({pierce:true}) ->
 * DOM.querySelector(root, selector) -> CSS.getMatchedStylesForNode(nodeId).
 * The response's `inherited[]` is the ancestor cascade devtools shows under
 * "inherited from"; we strip user-agent + implicit rules at source. Detaches in
 * finally. Throws on attach contention (devtools already attached) so the caller
 * can soft-fail to cssom-only capture.
 */
async function cdpInheritedChain(tabId, selector) {
	if (!tabId) throw new Error('no tab id');
	if (!selector) throw new Error('no selector');
	const target = { tabId };
	let attached = false;
	try {
		await chrome.debugger.attach(target, '1.3');
		attached = true;
		await chrome.debugger.sendCommand(target, 'DOM.enable');
		await chrome.debugger.sendCommand(target, 'CSS.enable');
		// Pierce:true so the tree (and the inherited chain) crosses closed shadow
		// roots, the v2 addition over v1's pierce:false.
		const doc = await chrome.debugger.sendCommand(target, 'DOM.getDocument', { depth: -1, pierce: true });
		const closedShadowRoots = countClosedShadowRoots(doc.root);
		const found = await chrome.debugger.sendCommand(target, 'DOM.querySelector', {
			nodeId: doc.root.nodeId,
			selector,
		});
		if (!found || !found.nodeId) throw new Error('target node not found via cdp');
		const matched = await chrome.debugger.sendCommand(target, 'CSS.getMatchedStylesForNode', {
			nodeId: found.nodeId,
		});
		const inherited = [];
		for (const entry of matched.inherited || []) {
			for (const rm of entry.matchedCSSRules || []) {
				const stripped = stripCdpRule(rm);
				if (stripped) inherited.push(stripped);
			}
		}
		return { inherited, closedShadowRoots };
	} finally {
		if (attached) {
			try {
				await chrome.debugger.detach(target);
			} catch (e) {
				// Already detached or tab gone; nothing to recover.
			}
		}
	}
}

/** Recursively count author-closed shadow roots in a cdp DOM.Node tree. */
function countClosedShadowRoots(node) {
	let count = 0;
	if (node.shadowRoots) {
		for (const sr of node.shadowRoots) {
			if (sr.shadowRootType === 'closed') count++;
			count += countClosedShadowRoots(sr);
		}
	}
	if (node.children) {
		for (const child of node.children) count += countClosedShadowRoots(child);
	}
	return count;
}

/**
 * Normalizes one cdp RuleMatch into { selector, properties, media? }, dropping
 * user-agent and implicit/disabled declarations (we synthesize our own
 * defaults, and ua rules would bloat the output). Returns null if nothing usable.
 */
function stripCdpRule(rm) {
	const rule = rm && rule_of(rm);
	if (!rule) return null;
	if ((rule.origin || 'regular') === 'user-agent') return null;
	const selector = rule.selectorList && rule.selectorList.text;
	if (!selector) return null;
	const properties = {};
	for (const p of (rule.style && rule.style.cssProperties) || []) {
		if (p.implicit || p.disabled || p.parsedOk === false) continue;
		if (!p.name || !p.value) continue;
		properties[p.name] = p.value;
	}
	if (Object.keys(properties).length === 0) return null;
	const out = { selector, properties };
	const media = rule.media && rule.media.find((m) => m.text);
	if (media) out.media = media.text;
	return out;
}

/** Unwrap the rule object from a cdp RuleMatch. */
function rule_of(rm) {
	return rm.rule || null;
}

/**
 * Runs a byok llm request: reads the provider key from storage, calls the
 * provider, and returns the raw model { text, usage }, where usage is the
 * provider-reported token count. Each caller (polish, the inspect ai passes)
 * parses the text into its own shape. Throws NO_KEY_CONFIGURED when no key is
 * stored (caller skips the step). The key is read here and attached to the
 * request only; it is never logged or persisted elsewhere.
 *
 * @param max - optional output-token ceiling, clamped to the provider limit
 *   (default 2000; raised by the schema-synthesis caller)
 */
async function llmRequest(provider, model, prompt, max) {
	const stored = await chrome.storage.local.get('byok.' + provider);
	const key = stored['byok.' + provider];
	if (!key) throw new Error('NO_KEY_CONFIGURED');

	const req = buildGenerationRequest(provider, key, model, prompt, max);
	const res = await fetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body) });
	if (!res.ok) throw new Error('PROVIDER_ERROR_' + res.status);
	const json = await res.json();
	const text = req.extract(json);
	const usage = req.usage(json);
	// A 200 with no usable text (e.g. a reasoning model that spent its token
	// budget thinking) or with no json object means the reply yields no edits.
	// Throw so the caller surfaces the cause instead of returning silent empties.
	// The call still spent tokens, so the error carries usage for the session total.
	if (!text || !text.trim()) throw usageError('EMPTY_COMPLETION', usage);
	if (!text.includes('{')) throw usageError('NON_JSON_REPLY', usage);
	// Return the raw text plus the provider-reported usage so the panel can total it.
	return { text, usage };
}

/** Default and per-provider output-token ceilings; an over-large request hard-400s some providers. */
const DEFAULT_MAX_TOKENS = 2000;
const PROVIDER_MAX_TOKENS = { anthropic: 8192, google: 8192, openai: 16384, openrouter: 8192 };

/**
 * Build a chat/generation request per provider (mirrors utils/byok.ts shapes).
 * The output-token cap is the requested `max` (or the 2000 default) clamped to
 * the provider's ceiling, since only the broker knows which provider is in play.
 */
function buildGenerationRequest(provider, key, model, prompt, max) {
	const json = 'application/json';
	const requested = typeof max === 'number' && max > 0 ? max : DEFAULT_MAX_TOKENS;
	const cap = Math.min(requested, PROVIDER_MAX_TOKENS[provider] || PROVIDER_MAX_TOKENS.openrouter);
	switch (provider) {
		case 'anthropic':
			return {
				url: 'https://api.anthropic.com/v1/messages',
				headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true', 'Content-Type': json },
				body: { model, max_tokens: cap, messages: [{ role: 'user', content: prompt }] },
				extract: (j) => (j.content && j.content[0] && j.content[0].text) || '',
				usage: (j) => ({ input: (j.usage && j.usage.input_tokens) || 0, output: (j.usage && j.usage.output_tokens) || 0 }),
			};
		case 'google':
			return {
				url: 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + encodeURIComponent(key),
				headers: { 'Content-Type': json },
				body: { contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: cap } },
				extract: (j) => (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts && j.candidates[0].content.parts[0] && j.candidates[0].content.parts[0].text) || '',
				usage: (j) => ({ input: (j.usageMetadata && j.usageMetadata.promptTokenCount) || 0, output: (j.usageMetadata && j.usageMetadata.candidatesTokenCount) || 0 }),
			};
		case 'openai':
			return {
				url: 'https://api.openai.com/v1/chat/completions',
				headers: { Authorization: 'Bearer ' + key, 'Content-Type': json },
				body: { model, messages: [{ role: 'user', content: prompt }], max_tokens: cap },
				extract: (j) => (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '',
				usage: (j) => ({ input: (j.usage && j.usage.prompt_tokens) || 0, output: (j.usage && j.usage.completion_tokens) || 0 }),
			};
		case 'openrouter':
		default:
			return {
				url: 'https://openrouter.ai/api/v1/chat/completions',
				headers: { Authorization: 'Bearer ' + key, 'Content-Type': json },
				body: { model, messages: [{ role: 'user', content: prompt }], max_tokens: cap },
				extract: (j) => (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '',
				usage: (j) => ({ input: (j.usage && j.usage.prompt_tokens) || 0, output: (j.usage && j.usage.completion_tokens) || 0 }),
			};
	}
}

/** An Error carrying the tokens already spent, so a failed-but-billed call still counts. */
function usageError(code, usage) {
	const err = new Error(code);
	err.usage = usage;
	return err;
}

/**
 * Fetches a cross-origin stylesheet from the background context. Validates the
 * url scheme, returns { text, mimeType }. Throws on non-2xx so the
 * caller records the href as still-inaccessible.
 */
async function fetchStylesheet(href) {
	if (!href) throw new Error('no href');
	let url;
	try {
		url = new URL(href);
	} catch {
		throw new Error('invalid url');
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported scheme');
	const res = await fetch(href);
	if (!res.ok) throw new Error('http ' + res.status);
	const text = await res.text();
	const mimeType = res.headers.get('content-type') || 'text/css';
	return { text, mimeType };
}
