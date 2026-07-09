/**
 * features/images.ts: responsive images + background images
 *
 * Pipeline position: reconcile
 * Reads from Captured: root, clone, bakedStyles
 * Writes to Captured: clone for img src/srcset and <picture>, bakedStyles for bg urls, and warnings
 *
 * A feature handler for image url resolution.
 *
 * CSS/spec reference: https://developer.mozilla.org/en-US/docs/Web/HTML/Element/picture
 * and https://developer.mozilla.org/en-US/docs/Web/CSS/background-image
 * Detection criterion: an <img> with srcset or inside <picture>, or a baked
 * background-image with a relative url(). It early-returns when none apply.
 * Transform contract: it pins each <img> to the browser-resolved currentSrc, which
 * is the image that actually rendered at the captured viewport, and drops srcset,
 * sizes, and <source>s so it renders deterministically. It also absolutizes
 * background-image url()s. It mutates the clone and bakedStyles only and does no
 * network work (the handler contract).
 *
 * Why this exists: srcset and <picture> pick a source from viewport and dpr at
 * render time. Once reparented, the browser may pick a different one, or none,
 * changing the pixels. Pinning currentSrc locks the captured-viewport image.
 * Background-image urls are usually relative to the source page and 404 when pasted,
 * so absolutizing fixes that. Cross-origin image urls render fine without cors,
 * since only canvas reads need it. So no base64 inline is required for fidelity, and
 * feature handlers may not fetch anyway. Truly unreachable assets get a warning
 * instead.
 */
import type { Captured } from '../../types';

const URL_IN_VALUE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

/**
 * Pins responsive images and absolutizes background-image urls.
 *
 * @param captured - clone + bakedStyles are mutated in place
 */
export function apply(captured: Captured): Captured {
	const base = document.baseURI || location.href;

	// Pin <img> to its rendered source, pairing clone imgs to live originals by order.
	const originalImgs = Array.from(captured.root.querySelectorAll('img'));
	const cloneImgs = Array.from(captured.clone.querySelectorAll('img'));
	if (originalImgs.length === cloneImgs.length) {
		for (let i = 0; i < cloneImgs.length; i++) {
			const orig = originalImgs[i];
			const cl = cloneImgs[i];
			if (!orig || !cl) continue;
			const resolved = orig.currentSrc || orig.src;
			// Don't pin a placeholder over a real source: when a lazy image never loaded
			// its real src on the live page (no loader ran), currentSrc is still the 1x1
			// spacer, but cloneElement already promoted the clone's src from data-src. Keep
			// that promoted real src rather than overwriting it with the spacer.
			if (resolved && !(isPlaceholder(resolved) && !isPlaceholder(cl.getAttribute('src') ?? ''))) {
				cl.setAttribute('src', toAbsolute(resolved, base) ?? resolved);
				// Drop responsive selectors so the pinned src is what renders.
				cl.removeAttribute('srcset');
				cl.removeAttribute('sizes');
			}
		}
	}

	// Inside <picture>, <source>s override <img src>, so remove them and the pinned
	// img src wins. The img was already pinned above.
	for (const picture of Array.from(captured.clone.querySelectorAll('picture'))) {
		for (const source of Array.from(picture.querySelectorAll('source'))) source.remove();
	}

	// Absolutize background-image url()s in the baked styles.
	for (const [clone, baked] of captured.bakedStyles) {
		for (const prop of ['background-image', 'background']) {
			const value = baked.get(prop);
			if (!value || !value.includes('url(')) continue;
			const rewritten = absolutizeUrls(value, base, captured);
			if (rewritten !== value) {
				baked.set(prop, rewritten);
				try {
					(clone as HTMLElement).style.setProperty(prop, rewritten);
				} catch {
					// Invalid for this element, so skip it.
				}
			}
		}
	}

	return captured;
}

/** Rewrite every relative url() in a value to absolute, and warn on truly opaque refs. */
function absolutizeUrls(value: string, base: string, captured: Captured): string {
	return value.replace(URL_IN_VALUE, (match, quote: string, url: string) => {
		if (/^(data:|blob:|https?:|#)/i.test(url)) return match; // Already absolute/inline/ref
		const abs = toAbsolute(url, base);
		if (!abs) {
			captured.warnings.push(`images: could not resolve background url ${url}`);
			return match;
		}
		return `url(${quote}${abs}${quote})`;
	});
}

/** The empty/spacer srcs a lazy-loader shows before swapping in the real image. */
function isPlaceholder(src: string): boolean {
	return !src || src.startsWith('data:image') || src.includes('1x1') || src.includes('placeholder');
}

/** Resolve a possibly-relative url against the document base, returning null if unparseable. */
function toAbsolute(url: string, base: string): string | null {
	try {
		return new URL(url, base).href;
	} catch {
		return null;
	}
}
