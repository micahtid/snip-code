/**
 * background.js: mv3 service worker
 *
 * phase: a (scaffold). pipeline position: n/a (privileged broker, not a phase).
 *
 * this is the extension's only privileged context. it exists so the content
 * script (sandboxed, same-origin-limited) can reach things it cannot touch
 * directly: cross-origin stylesheet fetches, tab screenshots, and byok llm
 * provider calls. it routes the message protocol in section 19.2.
 *
 * at this scaffold stage it only wires the toolbar icon to open the side panel.
 * the fetch / screenshot / llm / storage handlers land in later phases
 * (b: stylesheet + screenshot, i: llm, k: snippet storage + export).
 *
 * security: this worker reads byok keys from chrome.storage.local to attach
 * auth headers, but never logs them and never persists them anywhere else.
 */

// open the side panel when the toolbar icon is clicked. requires the
// "sidePanel" permission and a side_panel entry in the manifest.
chrome.runtime.onInstalled.addListener(() => {
	if (chrome.sidePanel) {
		chrome.sidePanel
			.setPanelBehavior({ openPanelOnActionClick: true })
			.catch((err) => console.warn('snipcode: could not set side panel behavior', err));
	}
});

/**
 * message router (section 19.2). the content script reaches privileged apis
 * only through here. handlers reply via the Response envelope
 * { requestId, ok, result?, error? }. returning true keeps the channel open for
 * the async sendResponse.
 *
 * at commit 3 only CAPTURE_SCREENSHOT is wired (the picker needs it to crop a
 * thumbnail). FETCH_STYLESHEET lands in commit 4, the llm + storage handlers in
 * later phases.
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	if (!message || typeof message !== 'object') return false;

	switch (message.type) {
		case 'CAPTURE_SCREENSHOT': {
			// content scripts cannot call captureVisibleTab; the worker can. it
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
			return true; // async response
		}

		case 'CDP_INHERITED': {
			// read the authored inherited cascade via the devtools protocol. only
			// the background can attach the debugger. capture-internal message (not
			// in the section-19.2 union); see capture/cdp.ts for the rationale.
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
			// byok phase-5 polish. the worker reads the key from storage (never
			// logs it), calls the provider, and returns the parsed { renameMap,
			// hoverRules } (section 19.2). content scripts cannot reach provider
			// hosts (page csp), so all llm traffic goes through here.
			const p = message.payload || {};
			llmRequest(p.provider, p.model, p.prompt)
				.then((result) => sendResponse({ requestId: message.requestId, ok: true, result }))
				.catch((err) => {
					const msg = String(err && err.message ? err.message : err);
					const code = msg === 'NO_KEY_CONFIGURED' ? 'NO_KEY_CONFIGURED' : 'PROVIDER_ERROR_0';
					sendResponse({ requestId: message.requestId, ok: false, error: { code, message: msg } });
				});
			return true;
		}

		case 'FETCH_STYLESHEET': {
			// background fetch bypasses cors via the <all_urls> host permission so
			// the content script can recover cross-origin stylesheets (section 19.2).
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
 * reads the authored inherited cascade for one node via the chrome devtools
 * protocol, with closed shadow roots pierced.
 *
 * flow: attach debugger -> enable DOM+CSS -> DOM.getDocument({pierce:true}) ->
 * DOM.querySelector(root, selector) -> CSS.getMatchedStylesForNode(nodeId).
 * the response's `inherited[]` is the ancestor cascade devtools shows under
 * "inherited from"; we strip user-agent + implicit rules at source. detaches in
 * finally. throws on attach contention (devtools already attached) so the caller
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
		// pierce:true so the tree (and the inherited chain) crosses closed shadow
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
				// already detached or tab gone; nothing to recover.
			}
		}
	}
}

/** recursively count author-closed shadow roots in a cdp DOM.Node tree. */
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
 * normalizes one cdp RuleMatch into { selector, properties, media? }, dropping
 * user-agent and implicit/disabled declarations (we synthesize our own
 * defaults, and ua rules would bloat the output). returns null if nothing usable.
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

/** unwrap the rule object from a cdp RuleMatch. */
function rule_of(rm) {
	return rm.rule || null;
}

/**
 * runs a byok llm polish request: reads the provider key from storage, calls the
 * provider, and parses a strict-json reply into { renameMap, hoverRules }. throws
 * NO_KEY_CONFIGURED when no key is stored (caller skips phase 5). the key is read
 * here and attached to the request only; it is never logged or persisted elsewhere.
 */
async function llmRequest(provider, model, prompt) {
	const stored = await chrome.storage.local.get('byok.' + provider);
	const key = stored['byok.' + provider];
	if (!key) throw new Error('NO_KEY_CONFIGURED');

	const req = buildGenerationRequest(provider, key, model, prompt);
	const res = await fetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body) });
	if (!res.ok) throw new Error('PROVIDER_ERROR_' + res.status);
	const text = req.extract(await res.json());
	return parseReply(text);
}

/** build a chat/generation request per provider (mirrors utils/byok.ts shapes). */
function buildGenerationRequest(provider, key, model, prompt) {
	const json = 'application/json';
	const MAX = 2000;
	switch (provider) {
		case 'anthropic':
			return {
				url: 'https://api.anthropic.com/v1/messages',
				headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true', 'Content-Type': json },
				body: { model, max_tokens: MAX, messages: [{ role: 'user', content: prompt }] },
				extract: (j) => (j.content && j.content[0] && j.content[0].text) || '',
			};
		case 'google':
			return {
				url: 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + encodeURIComponent(key),
				headers: { 'Content-Type': json },
				body: { contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: MAX } },
				extract: (j) => (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts && j.candidates[0].content.parts[0] && j.candidates[0].content.parts[0].text) || '',
			};
		case 'openai':
			return {
				url: 'https://api.openai.com/v1/chat/completions',
				headers: { Authorization: 'Bearer ' + key, 'Content-Type': json },
				body: { model, messages: [{ role: 'user', content: prompt }], max_tokens: MAX },
				extract: (j) => (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '',
			};
		case 'openrouter':
		default:
			return {
				url: 'https://openrouter.ai/api/v1/chat/completions',
				headers: { Authorization: 'Bearer ' + key, 'Content-Type': json },
				body: { model, messages: [{ role: 'user', content: prompt }], max_tokens: MAX },
				extract: (j) => (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '',
			};
	}
}

/** extract the first json object from the model's text and parse it leniently. */
function parseReply(text) {
	const match = text.match(/\{[\s\S]*\}/);
	if (!match) return { renameMap: {}, hoverRules: [] };
	try {
		const parsed = JSON.parse(match[0]);
		return {
			renameMap: parsed.renameMap && typeof parsed.renameMap === 'object' ? parsed.renameMap : {},
			hoverRules: Array.isArray(parsed.hoverRules) ? parsed.hoverRules : [],
		};
	} catch (e) {
		return { renameMap: {}, hoverRules: [] };
	}
}

/**
 * fetches a cross-origin stylesheet from the background context. validates the
 * url scheme, returns { text, mimeType } (section 19.2). throws on non-2xx so the
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
