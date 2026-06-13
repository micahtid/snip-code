/**
 * resolve/fonts.ts: @font-face resolution
 *
 * Pipeline position: resolve
 * Reads from Captured: bakedStyles, fonts
 * Writes to Captured: fonts (absolutized src, filtered to used families)
 *
 * Travel-with-the-snip rule for fonts: a used custom font must carry its
 * @font-face and an absolute src so it loads from the snip's new home.
 *
 * Why this exists: @font-face src urls are usually relative to the source page;
 * pasted elsewhere they 404. This resolves them to absolute urls and narrows the
 * captured @font-face list to families the snip actually uses (read from the
 * baked font-family declarations). Generic keywords (serif, system-ui,...) never
 * match a captured @font-face family, so they fall out naturally, no banned
 * keyword Set needed. Ported (rewritten) from v1
 * font-extractor.ts; reused by assistive/fonts.ts.
 */
import type { Captured, FontFace } from '../types';

const URL_IN_SRC = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

/**
 * Narrows captured @font-face entries to used families and absolutizes their src.
 *
 * @param captured - fonts is replaced in place with the resolved, used subset
 */
export function resolveFonts(captured: Captured): void {
	const used = usedFamilies(captured);
	const base = document.baseURI || location.href;
	const seen = new Set<string>();
	const resolved: FontFace[] = [];

	for (const font of captured.fonts) {
		const family = normalizeFamily(font.family).toLowerCase();
		if (!used.has(family)) continue; // Unused face, drop
		const src = absolutizeSrc(font.src, base);
		const key = `${family}|${src}|${descriptorKey(font)}`;
		if (seen.has(key)) continue; // Dedupe identical faces
		seen.add(key);
		resolved.push({ family: font.family, src, descriptors: font.descriptors });
	}
	captured.fonts = resolved;
}

/** The set of font-family names referenced anywhere in the baked styles. */
function usedFamilies(captured: Captured): Set<string> {
	const families = new Set<string>();
	for (const [, baked] of captured.bakedStyles) {
		for (const prop of ['font-family', 'font']) {
			const value = baked.get(prop);
			if (!value) continue;
			for (const token of value.split(',')) {
				const name = normalizeFamily(token).toLowerCase();
				if (name) families.add(name);
			}
		}
	}
	return families;
}

/** Rewrite every url() inside an @font-face src to an absolute url. local()/data: untouched. */
function absolutizeSrc(src: string, base: string): string {
	return src.replace(URL_IN_SRC, (match, quote: string, url: string) => {
		if (/^(data:|blob:|https?:)/i.test(url)) return match; // Already absolute or inline
		try {
			return `url(${quote}${new URL(url, base).href}${quote})`;
		} catch {
			return match;
		}
	});
}

/** Strip quotes and trim a font-family token. The `font` shorthand may carry size/style noise; the last comma-list entries are still family names. */
function normalizeFamily(raw: string): string {
	return raw
		.replace(/^["']|["']$/g, '')
		.replace(/^\s*(?:\d+(?:\.\d+)?(?:px|rem|em|%)?\/?\S*\s+)+/, '') // Drop leading size/line-height from `font` shorthand
		.trim();
}

/** A stable key over the weight/style/unicode-range descriptors for dedupe. */
function descriptorKey(font: FontFace): string {
	return Object.entries(font.descriptors)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([k, v]) => `${k}:${v}`)
		.join(';');
}
