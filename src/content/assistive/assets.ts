/**
 * assistive/assets.ts: asset extraction.
 *
 * Pipeline position: capture. Assistive runs the capture phase only.
 * Reads from Captured: root.
 * It does not write to Captured. It returns an asset manifest.
 *
 * No principles apply here, since this is extraction.
 *
 * Why this exists: assistive mode lists the images and icons a component depends on so an
 * agent can fetch or re-reference them. This collects <img> sources (resolved from
 * currentSrc), css background-image urls, and inline svg icons across the subtree, all
 * absolutized. This was ported and rewritten from v1 assets/asset-extractor.ts.
 */
import { toAbsoluteUrl } from '../../utils/url';

const URL_IN_VALUE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

/** The asset manifest for the assistive json. */
export interface AssetManifest {
	images: string[];
	icons: string[];
}

/**
 * Collects image and icon assets used by the subtree.
 *
 * @param root - the picked element
 */
export function extractAssets(root: Element): AssetManifest {
	const base = document.baseURI || location.href;
	const images = new Set<string>();
	const icons = new Set<string>();

	for (const img of Array.from(root.querySelectorAll('img'))) {
		const src = img.currentSrc || img.getAttribute('src') || '';
		const abs = toAbsoluteUrl(src, base);
		if (abs) images.add(abs);
	}

	for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
		const bg = getComputedStyle(el).backgroundImage;
		if (bg && bg.includes('url(')) {
			let m: RegExpExecArray | null;
			URL_IN_VALUE.lastIndex = 0;
			while ((m = URL_IN_VALUE.exec(bg)) !== null) {
				const abs = toAbsoluteUrl(m[2] ?? '', base);
				if (abs) images.add(abs);
			}
		}
	}

	// Inline svgs are icons, so record a count-distinguishable marker. Their outer
	// markup is in the snip itself, so a stable id or use ref is the useful signal.
	for (const svg of Array.from(root.querySelectorAll('svg'))) {
		const use = svg.querySelector('use');
		const ref = use?.getAttribute('href') ?? use?.getAttribute('xlink:href');
		icons.add(ref ?? `inline-svg:${svg.childElementCount}`);
	}

	return { images: [...images], icons: [...icons] };
}
