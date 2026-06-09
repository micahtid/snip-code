/**
 * assistive/assets.ts — asset extraction
 *
 * Phase: j (assistive mode) — see SNIPCODE-REWRITE-PLAN.md section 12
 * Pipeline position: 1 — capture (assistive runs phase 1 only)
 * Reads from Captured: root
 * Writes to Captured: n/a (returns an asset manifest)
 *
 * Principles applied: none (extraction).
 *
 * Why this exists: assistive mode lists the images and icons a component depends
 * on so an agent can fetch or re-reference them. this collects <img> sources
 * (resolved currentSrc), css background-image urls, and inline svg icons across
 * the subtree, absolutized. ported (rewritten) from v1 assets/asset-extractor.ts.
 */

const URL_IN_VALUE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

/** the asset manifest for the assistive json (section 9 assets block). */
export interface AssetManifest {
	images: string[];
	icons: string[];
}

/**
 * collects image and icon assets used by the subtree.
 *
 * @param root — the picked element
 */
export function extractAssets(root: Element): AssetManifest {
	const base = document.baseURI || location.href;
	const images = new Set<string>();
	const icons = new Set<string>();

	for (const img of Array.from(root.querySelectorAll('img'))) {
		const src = img.currentSrc || img.getAttribute('src') || '';
		const abs = toAbsolute(src, base);
		if (abs) images.add(abs);
	}

	for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
		const bg = getComputedStyle(el).backgroundImage;
		if (bg && bg.includes('url(')) {
			let m: RegExpExecArray | null;
			URL_IN_VALUE.lastIndex = 0;
			while ((m = URL_IN_VALUE.exec(bg)) !== null) {
				const abs = toAbsolute(m[2] ?? '', base);
				if (abs) images.add(abs);
			}
		}
	}

	// inline svgs are icons; record a count-distinguishable marker (their outer
	// markup is in the snip itself, so a stable id/use ref is the useful signal).
	for (const svg of Array.from(root.querySelectorAll('svg'))) {
		const use = svg.querySelector('use');
		const ref = use?.getAttribute('href') ?? use?.getAttribute('xlink:href');
		icons.add(ref ?? `inline-svg:${svg.childElementCount}`);
	}

	return { images: [...images], icons: [...icons] };
}

/** resolve a possibly-relative url against the document base; '' if unusable. */
function toAbsolute(url: string, base: string): string {
	if (!url || url.startsWith('data:')) return url;
	try {
		return new URL(url, base).href;
	} catch {
		return '';
	}
}
