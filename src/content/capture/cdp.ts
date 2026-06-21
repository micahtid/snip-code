/**
 * capture/cdp.ts: privileged capture augmentation (inherited chain + cross-origin)
 *
 * Pipeline position: capture
 * Reads from Captured: root, element.selector, inaccessible.crossOriginStylesheets
 * Writes to Captured: foundationRules (cdp inherited rules), componentRules,
 * variables, fonts, keyframes (recovered cross-origin), inaccessible
 *
 * Feeds the inheritance bake: the cdp inherited chain is the authored ancestor
 * cascade that bake.ts later bakes onto the snip root.
 *
 * Why this exists: two things the content script cannot do alone. (1) read the
 * *authored* ancestor cascade (devtools' "inherited from" section), only the
 * chrome devtools protocol exposes it, and chrome.debugger is background-only.
 * (2) read cross-origin stylesheets blocked by the same-origin policy, only a
 * background fetch with <all_urls> host permission can. Both are delegated to
 * the background worker over capture-internal messages (CDP_INHERITED /
 * FETCH_STYLESHEET).
 *
 * The v2 change vs v1: DOM.getDocument runs with { pierce: true } so the document
 * tree includes closed shadow roots, letting the inherited chain resolve through
 * them (the full shadow handler lands later).
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
 * folds the ancestor rules into foundationRules. Soft-fails: if the debugger is
 * busy (devtools open) or attach is refused, the snip continues on cssom data
 * alone with a warning, cdp is an enhancement, never a hard dependency.
 *
 * @param captured - the in-flight capture; mutated in place
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
		// Pierce:true means cdp saw the closed roots; record how many for transparency.
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
 * sheets.ts records the hrefs of sheets that threw SecurityError; this fetches
 * each through the background (whose <all_urls> permission bypasses cors), parses
 * the text into rules, and merges them into Captured. Recovered hrefs are dropped
 * from the inaccessible list. Failures stay recorded as inaccessible with a
 * warning rather than blocking the snip.
 *
 * @param captured - the in-flight capture; mutated in place
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

/** Matches each url() token in a css value (font src), quote-tolerant. */
const URL_IN_VALUE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

/**
 * Recovers the @font-face rules cross-origin stylesheets hide, by reading the text the
 * browser already parsed over cdp. recoverCrossOriginSheets above tries a privileged
 * re-fetch, which a cdn waf often blocks for the extension origin; this fallback reads
 * the same sheets through the devtools protocol, which is not bound by the same-origin
 * policy and needs no network round-trip. Runs over the hrefs still flagged inaccessible
 * after the fetch attempt, so it closes exactly the font-discovery gap those sites leave:
 * a snip whose web font lives only in a cdn-hosted, unreadable, unfetchable sheet.
 *
 * Scope is deliberately @font-face only: this plan recovers fonts (a resource the
 * artifact must carry), not the full cross-origin cascade, so only the faces are
 * harvested and the inaccessible list is left untouched. A recovered src is relative to
 * its STYLESHEET url, not the page, so it is absolutized against the sheet href here;
 * resolveFonts later absolutizes against the page baseURI and skips an already-absolute
 * url, so a root-relative src on a cdn-hosted sheet (a common next.js shape) resolves to
 * the cdn host rather than the wrong page origin.
 *
 * @param captured - the in-flight capture; captured.fonts is extended in place
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

		if (!res?.ok || !res.result?.sheets?.length) return; // Nothing recovered; leave the list as-is.
		for (const sheet of res.result.sheets) {
			try {
				const delta = await parseCssText(sheet.text, 'cdp');
				for (const font of delta.fonts) {
					font.src = absolutizeAgainst(font.src, sheet.href);
					captured.fonts.push(font);
				}
			} catch (err) {
				captured.warnings.push(`cdp font recovery parse failed for ${sheet.href}: ${(err as Error).message}`);
			}
		}
	} catch (err) {
		captured.warnings.push(`cdp font recovery failed: ${(err as Error).message}`);
	}
}

/** Rewrites every url() in a css value to an absolute url against `base`. data:/blob:/absolute left as-is. */
function absolutizeAgainst(value: string, base: string): string {
	return value.replace(URL_IN_VALUE, (match, quote: string, url: string) => {
		if (/^(data:|blob:|https?:)/i.test(url)) return match;
		try {
			return `url(${quote}${new URL(url, base).href}${quote})`;
		} catch {
			return match;
		}
	});
}
