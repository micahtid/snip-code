/**
 * inspect/fonts.ts: page-wide font extractor
 *
 * Pipeline position: inspect (page-scoped; reads the live dom directly, does not run the element pipeline)
 * Reads from DOM: document/window (live; page must be loaded)
 * Writes to: nothing (pure extraction, no side effects)
 *
 * Principles applied: none (extraction).
 *
 * Why this exists: the fonts inspector lists every font family the page renders,
 * most-used first, so the panel can show an "Aa" preview, the web/system origin,
 * and the variant count. Web vs system is decided by the FontFaceSet
 * (`document.fonts`), which mirrors every @font-face the page declares; usage and
 * variants come from a single walk of the rendered text. Ported (rewritten) from
 * v1 fonts/font-extractor.ts, dropping the class/logger ceremony and the
 * @font-face url + load-state fields the panel never showed.
 */
import type { FontReport, FontVariant } from './types';

/** Non-text tags whose computed font-family carries no rendered-text signal. */
const SKIP_TAGS = new Set(['SCRIPT', 'NOSCRIPT', 'STYLE', 'TEMPLATE', 'IFRAME', 'LINK', 'META', 'HEAD', 'BASE', 'BR', 'WBR']);

/** Generic css families are keywords, not real font names; they never list as fonts. */
const GENERIC_FAMILIES = new Set([
	'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy',
	'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded',
	'emoji', 'math', 'fangsong',
]);

/** A safety cap so a pathologically large page cannot stall the walk. */
const MAX_ELEMENTS = 2000;

/** Working tally for one family: its usage count and the distinct variants seen. */
interface FamilyUsage {
	count: number;
	variants: Map<string, FontVariant>;
}

/**
 * Collects every non-generic font family the page renders, most-used first.
 */
export function extractPageFonts(): FontReport[] {
	const webFamilies = declaredWebFamilies();
	const usage = walkRenderedFonts();

	const reports: FontReport[] = [];
	for (const [family, used] of usage) {
		reports.push({
			family,
			origin: webFamilies.has(family) ? 'web' : 'system',
			usageCount: used.count,
			variants: [...used.variants.values()].sort((a, b) => parseInt(a.weight) - parseInt(b.weight)),
		});
	}
	return reports.sort((a, b) => b.usageCount - a.usageCount);
}

/**
 * The set of families declared as web fonts. `document.fonts` (the FontFaceSet)
 * holds a FontFace for every @font-face the page declares, so membership here is
 * the web-vs-system signal without re-parsing stylesheets.
 */
function declaredWebFamilies(): Set<string> {
	const families = new Set<string>();
	document.fonts.forEach((face) => {
		const family = normalizeFamily(face.family);
		// Skip the panel's own fonts, injected from the extension origin.
		const src = (face as FontFace & { src?: string }).src ?? '';
		if (typeof src === 'string' && src.includes('chrome-extension://')) return;
		if (family && !isGeneric(family)) families.add(family);
	});
	return families;
}

/**
 * Walks the rendered text and tallies, per family, how many elements use it and
 * which weight/style variants appear. Only the first listed family of each
 * element is counted, since that is the one that actually renders.
 */
function walkRenderedFonts(): Map<string, FamilyUsage> {
	const usage = new Map<string, FamilyUsage>();
	const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
		acceptNode: (node) => (SKIP_TAGS.has((node as Element).tagName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
	});

	let seen = 0;
	for (let node = walker.nextNode(); node && seen < MAX_ELEMENTS; node = walker.nextNode()) {
		seen++;
		const el = node as Element;
		// Only elements with their own text contribute the font they paint that text in.
		const hasDirectText = Array.from(el.childNodes).some((c) => c.nodeType === Node.TEXT_NODE && c.textContent?.trim());
		if (!hasDirectText) continue;

		const style = getComputedStyle(el);
		const family = firstFamily(style.fontFamily);
		if (!family || isGeneric(family)) continue;

		const variant: FontVariant = { weight: style.fontWeight, style: style.fontStyle };
		const existing = usage.get(family);
		if (existing) {
			existing.count++;
			existing.variants.set(`${variant.weight}:${variant.style}`, variant);
		} else {
			usage.set(family, { count: 1, variants: new Map([[`${variant.weight}:${variant.style}`, variant]]) });
		}
	}
	return usage;
}

/** The first listed family in a font-family stack, normalized; '' if absent. */
function firstFamily(stack: string): string {
	return normalizeFamily(stack.split(',')[0] ?? '');
}

/** Strip surrounding quotes and whitespace from a family token. */
function normalizeFamily(raw: string): string {
	return raw.replace(/^["']|["']$/g, '').trim();
}

/** True for a generic css family keyword (not a real font name). */
function isGeneric(family: string): boolean {
	return GENERIC_FAMILIES.has(family.toLowerCase());
}
