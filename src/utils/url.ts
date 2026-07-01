/**
 * utils/url.ts: absolutize a possibly-relative url
 *
 * Pipeline position: n/a; cross-cutting utility
 *
 * Why this exists: several extractors, such as assistive/assets, inspect/assets,
 * and inspect/colors, need to turn a page-relative url into an absolute one against
 * the document base. This was duplicated; it lives here once so both the
 * element-scoped and page-scoped extractors resolve urls identically.
 */

/**
 * Resolves a possibly-relative url against a base. Returns '' when the url cannot
 * be parsed, so the caller drops it, and passes `data:` urls through unchanged
 * because they are already self-contained.
 *
 * @param url - the raw url, possibly relative
 * @param base - the document base to resolve against, e.g. document.baseURI || location.href
 */
export function toAbsoluteUrl(url: string, base: string): string {
	if (!url || url.startsWith('data:')) return url;
	try {
		return new URL(url, base).href;
	} catch {
		return '';
	}
}
