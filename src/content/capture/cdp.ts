/**
 * capture/cdp.ts — privileged capture augmentation (inherited chain + cross-origin)
 *
 * Phase: b (capture) — see SNIPCODE-REWRITE-PLAN.md section 12
 * Pipeline position: 1 — capture
 * Reads from Captured: root, element.selector, inaccessible.crossOriginStylesheets
 * Writes to Captured: foundationRules (cdp inherited rules), componentRules,
 *   variables, fonts, keyframes (recovered cross-origin), inaccessible
 *
 * Principles applied: feeds P2 (inheritance crosses snip boundaries) — the cdp
 * inherited chain is the authored ancestor cascade that bake.ts later bakes onto
 * the snip root.
 *
 * Why this exists: two things the content script cannot do alone. (1) read the
 * *authored* ancestor cascade (devtools' "inherited from" section) — only the
 * chrome devtools protocol exposes it, and chrome.debugger is background-only.
 * (2) read cross-origin stylesheets blocked by the same-origin policy — only a
 * background fetch with <all_urls> host permission can. both are delegated to
 * the background worker over capture-internal messages (CDP_INHERITED /
 * FETCH_STYLESHEET). FETCH_STYLESHEET is the section-19.2 protocol message;
 * CDP_INHERITED is a capture-internal extension (section 19.2 does not enumerate
 * a cdp message, so it is intentionally kept out of the typed MessageType union
 * and handled by the background's generic router).
 *
 * the v2 change vs v1: DOM.getDocument runs with { pierce: true } so the document
 * tree includes closed shadow roots, letting the inherited chain resolve through
 * them (the full shadow handler lands in commit 23).
 */
import type { Captured, CssRule } from '../types';
import { parseCssText, specificityOf } from './sheets';

/** temporary marker attribute so the background can resolve the live node by selector. */
const TAG_ATTR = 'data-snipcode-target';

/** one ancestor rule the background lifted out of CSS.getMatchedStylesForNode. */
interface CdpRule {
	selector: string;
	properties: Record<string, string>;
	media?: string;
}

/** the background's reply to CDP_INHERITED. */
interface CdpInheritedResult {
	inherited: CdpRule[];
	closedShadowRoots: number;
	warning?: string;
}

/**
 * augments Captured with the authored inherited cascade via cdp.
 *
 * tags the live root with a unique attribute, asks the background to attach the
 * debugger and read CSS.getMatchedStylesForNode().inherited for that node, then
 * folds the ancestor rules into foundationRules (P2 will bake the inherited
 * properties onto the snip root in commit 7). soft-fails: if the debugger is
 * busy (devtools open) or attach is refused, the snip continues on cssom data
 * alone with a warning — cdp is an enhancement, never a hard dependency.
 *
 * @param captured — the in-flight capture; mutated in place
 */
export async function augmentInheritedChainViaCDP(captured: Captured): Promise<void> {
	const root = captured.root;
	const token = `t${Math.floor(performance.now())}${root.tagName.length}`;
	root.setAttribute(TAG_ATTR, token);
	const selector = `[${TAG_ATTR}="${token}"]`;
	try {
		const res = (await chrome.runtime.sendMessage({
			type: 'CDP_INHERITED',
			requestId: crypto.randomUUID(),
			payload: { selector },
		})) as { ok: boolean; result?: CdpInheritedResult; error?: { message: string } };

		if (!res?.ok || !res.result) {
			captured.warnings.push(`cdp inherited chain unavailable: ${res?.error?.message ?? 'no response'}`);
			return;
		}
		const { inherited, closedShadowRoots, warning } = res.result;
		if (warning) captured.warnings.push(warning);
		// pierce:true means cdp saw the closed roots; record how many for transparency.
		captured.inaccessible.closedShadowRoots = closedShadowRoots;

		for (const rule of inherited) {
			const properties = new Map(Object.entries(rule.properties));
			const entry: CssRule = {
				selector: rule.selector,
				properties,
				specificity: specificityOf(rule.selector),
				source: 'cdp',
				...(rule.media ? { mediaQuery: rule.media } : {}),
			};
			// inherited ancestor rules are broadly relevant to the snip root, so
			// they live in the foundation layer (P2 baking consumes them).
			captured.foundationRules.push(entry);
		}
	} catch (err) {
		captured.warnings.push(`cdp inherited chain failed: ${(err as Error).message}`);
	} finally {
		root.removeAttribute(TAG_ATTR);
	}
}

/**
 * recovers cross-origin stylesheets that the content script could not read.
 *
 * sheets.ts records the hrefs of sheets that threw SecurityError; this fetches
 * each through the background (whose <all_urls> permission bypasses cors), parses
 * the text into rules, and merges them into Captured. recovered hrefs are dropped
 * from the inaccessible list. failures stay recorded as inaccessible with a
 * warning rather than blocking the snip.
 *
 * @param captured — the in-flight capture; mutated in place
 */
export async function recoverCrossOriginSheets(captured: Captured): Promise<void> {
	const pending = captured.inaccessible.crossOriginStylesheets;
	if (pending.length === 0) return;
	const stillInaccessible: string[] = [];

	for (const href of pending) {
		try {
			const res = (await chrome.runtime.sendMessage({
				type: 'FETCH_STYLESHEET',
				requestId: crypto.randomUUID(),
				payload: { href },
			})) as { ok: boolean; result?: { text: string; mimeType: string }; error?: { message: string } };

			if (!res?.ok || !res.result?.text) {
				stillInaccessible.push(href);
				captured.warnings.push(`cross-origin stylesheet unreadable: ${href}`);
				continue;
			}
			const delta = await parseCssText(res.result.text, 'cssom');
			captured.foundationRules.push(...delta.foundationRules);
			captured.componentRules.push(...delta.componentRules);
			captured.variables.push(...delta.variables);
			captured.fonts.push(...delta.fonts);
			captured.keyframes.push(...delta.keyframes);
			captured.stylesheets.push({ href, origin: 'cross-origin', ruleCount: delta.componentRules.length + delta.foundationRules.length });
		} catch (err) {
			stillInaccessible.push(href);
			captured.warnings.push(`cross-origin fetch failed for ${href}: ${(err as Error).message}`);
		}
	}
	captured.inaccessible.crossOriginStylesheets = stillInaccessible;
}
