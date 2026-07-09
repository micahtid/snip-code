/**
 * capture/cdp.ts: privileged capture augmentation (inherited chain and cross-origin sheets)
 *
 * Pipeline position: capture
 * Reads from Captured: root, element.selector, inaccessible.crossOriginStylesheets
 * Writes to Captured: foundationRules from cdp inherited rules, componentRules,
 * variables, fonts, keyframes recovered cross-origin, inaccessible
 *
 * Feeds the inheritance bake. The cdp inherited chain is the authored ancestor
 * cascade that bake.ts later bakes onto the snip root.
 *
 * Why this exists: two things the content script cannot do alone. First, it reads
 * the *authored* ancestor cascade, the devtools "inherited from" section. Only the
 * chrome devtools protocol exposes it, and chrome.debugger is background-only.
 * Second, it reads cross-origin stylesheets blocked by the same-origin policy,
 * which only a background fetch with <all_urls> host permission can do. Both are
 * delegated to the background worker over capture-internal messages
 * (CDP_INHERITED / FETCH_STYLESHEET).
 *
 * The v2 change versus v1 is that DOM.getDocument runs with { pierce: true } so
 * the document tree includes closed shadow roots, letting the inherited chain
 * resolve through them. The full shadow handler lands later.
 */
import type { Captured, CssRule } from '../types';
import { parseCssText, specificityOf } from './sheets';

/** Temporary marker attribute so the background can resolve the live node by selector. */
const TAG_ATTR = 'data-snipcode-target';

/** One ancestor rule the background lifted out of CSS.getMatchedStylesForNode. */
interface CdpRule {
	selector: string;
	properties: Record<string, string>;
	media?: string;
}

/** The background's reply to CDP_INHERITED. */
interface CdpInheritedResult {
	inherited: CdpRule[];
	closedShadowRoots: number;
	warning?: string;
}

/**
 * Augments Captured with the authored inherited cascade via cdp.
 *
 * Tags the live root with a unique attribute, asks the background to attach the
 * debugger and read CSS.getMatchedStylesForNode().inherited for that node, then
 * folds the ancestor rules into foundationRules. It soft-fails: if the debugger is
 * busy (for example when devtools is open) or attach is refused, the snip
 * continues on cssom data alone with a warning. cdp is an enhancement, never a
 * hard dependency.
 *
 * @param captured - the in-flight capture, mutated in place
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
		// Pierce:true means cdp saw the closed roots, so record how many for transparency.
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
			// Inherited ancestor rules are broadly relevant to the snip root, so
			// they live in the foundation layer.
			captured.foundationRules.push(entry);
		}
	} catch (err) {
		captured.warnings.push(`cdp inherited chain failed: ${(err as Error).message}`);
	} finally {
		root.removeAttribute(TAG_ATTR);
	}
}

/**
 * Recovers cross-origin stylesheets that the content script could not read.
 *
 * sheets.ts records the hrefs of sheets that threw SecurityError. This fetches
 * each through the background, whose <all_urls> permission bypasses cors, parses
 * the text into rules, and merges them into Captured. Recovered hrefs are dropped
 * from the inaccessible list. Failures stay recorded as inaccessible with a
 * warning rather than blocking the snip.
 *
 * @param captured - the in-flight capture, mutated in place
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
			const delta = await parseCssText(res.result.text, 'cssom', href);
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

/**
 * Recovers the @font-face rules that cross-origin stylesheets hide, by reading the text
 * the browser already parsed over cdp. recoverCrossOriginSheets above tries a privileged
 * re-fetch, which a cdn waf often blocks for the extension origin. This fallback reads
 * the same sheets through the devtools protocol, which is not bound by the same-origin
 * policy and needs no network round-trip. It runs over the hrefs still flagged
 * inaccessible after the fetch attempt, so it closes exactly the font-discovery gap those
 * sites leave, when a snip's web font lives only in a cdn-hosted, unreadable, unfetchable
 * sheet.
 *
 * Scope is deliberately @font-face only. The goal is to recover fonts, a resource the
 * artifact must carry, not the full cross-origin cascade, so only the faces are
 * harvested and the inaccessible list is left untouched. parseCssText absolutizes each
 * recovered src against the sheet href, since a src is relative to its stylesheet, not the
 * page, so a relative or root-relative src on a cdn-hosted sheet resolves to the cdn
 * host rather than the wrong page origin.
 *
 * @param captured - the in-flight capture. captured.fonts is extended in place
 */
export async function recoverCrossOriginFontsViaCDP(captured: Captured): Promise<void> {
	const pending = captured.inaccessible.crossOriginStylesheets;
	if (pending.length === 0) return;
	try {
		const res = (await chrome.runtime.sendMessage({
			type: 'CDP_STYLESHEETS',
			requestId: crypto.randomUUID(),
			payload: { hrefs: pending },
		})) as { ok: boolean; result?: { sheets: Array<{ href: string; text: string }> }; error?: { message: string } };

		if (!res?.ok || !res.result?.sheets?.length) return; // Nothing recovered, so leave the list as-is.
		for (const sheet of res.result.sheets) {
			try {
				const delta = await parseCssText(sheet.text, 'cdp', sheet.href);
				captured.fonts.push(...delta.fonts);
			} catch (err) {
				captured.warnings.push(`cdp font recovery parse failed for ${sheet.href}: ${(err as Error).message}`);
			}
		}
	} catch (err) {
		captured.warnings.push(`cdp font recovery failed: ${(err as Error).message}`);
	}
}
