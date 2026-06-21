/**
 * resolve/inline.ts: inline external resources so the snip is self-contained
 *
 * Pipeline position: resolve (closing step, after the standalone reconciliation)
 * Reads from Captured: clone, bakedStyles, fonts, page
 * Writes to Captured: clone (img src), bakedStyles (background url), fonts (src), warnings
 *
 * Why this exists: a snip that references the origin (a webfont url, an image url, a
 * background-image url) breaks the moment it is pasted somewhere that cannot reach
 * those urls, hotlink-protected fonts, authenticated image cdns, or simply offline.
 * The artifact must not depend on the origin. This step fetches every referenced font
 * and image through the extension's privileged background context (whose <all_urls>
 * permission reaches resources the page's own context cannot) and rewrites the
 * reference to a base64 data uri, so the snip carries its pixels with it.
 *
 * Best-effort and deterministic: a fetch that fails (blocked, oversize, offline)
 * leaves the absolute url in place rather than throwing, so the snip still ships; given
 * the same responses the rewrite is byte-identical. Bounded by a resource cap and (in
 * the background) a size cap so a heavy page cannot bloat the output without limit.
 */
import type { Captured } from '../types';

/** Matches each url() token in a css value (font src, background-image), quote-tolerant. */
const URL_IN_VALUE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

/** The background-carrying baked properties whose url()s are inlined. */
const BG_PROPS = ['background-image', 'background'] as const;

/** Cap on resources fetched per snip, so a gallery-heavy page cannot inline without bound. */
const MAX_RESOURCES = 48;

/** Concurrent background fetches; keeps the snip responsive without flooding the worker. */
const FETCH_CONCURRENCY = 6;

/** Per-fetch deadline; a stalled resource is abandoned (url kept) rather than hanging the snip. */
const FETCH_TIMEOUT_MS = 8000;

/** A resource larger than this is left as a url reference rather than inlined (mirrors the background cap). */
const MAX_INLINE_BYTES = 3 * 1024 * 1024;

/**
 * Inlines every referenced font and image as a data uri. Collects the unique absolute
 * urls across @font-face src, <img> src, and baked background-image, fetches them
 * (bounded), and rewrites each reference to the fetched data uri. Leaves any url it
 * could not fetch untouched.
 *
 * @param captured - clone, bakedStyles, and fonts are rewritten in place
 */
export async function inlineResources(captured: Captured): Promise<void> {
	const base = captured.page.url || document.baseURI || location.href;
	const wanted = new Set<string>();
	const add = (raw: string): void => {
		if (!raw || raw.startsWith('data:')) return;
		const abs = absolute(raw, base);
		if (abs && /^https?:/i.test(abs)) wanted.add(abs);
	};

	const imgs = collectImages(captured.clone);
	for (const font of captured.fonts) for (const u of urlsIn(font.src)) add(u);
	for (const img of imgs) add(img.getAttribute('src') ?? '');
	for (const [, baked] of captured.bakedStyles) {
		for (const prop of BG_PROPS) for (const u of urlsIn(baked.get(prop) ?? '')) add(u);
	}

	if (wanted.size === 0) return;
	const urls = [...wanted].slice(0, MAX_RESOURCES);
	if (urls.length < wanted.size) {
		captured.warnings.push(`inline: ${wanted.size - urls.length} resource(s) over the cap left as url references`);
	}

	const dataByUrl = await fetchAll(urls);
	if (dataByUrl.size === 0) {
		// Nothing inlined: the rewrite passes below are all no-ops, but the closing
		// self-containment guard must still run so an un-inlinable face is dropped to its
		// fallback rather than shipping a dead origin url.
		captured.warnings.push('inline: no resources could be inlined; the snip references the origin for fonts/images');
	}

	// Rewrite @font-face src.
	for (const font of captured.fonts) font.src = rewriteUrls(font.src, base, dataByUrl);
	// Rewrite <img> src.
	for (const img of imgs) {
		const src = img.getAttribute('src');
		if (!src || src.startsWith('data:')) continue;
		const data = dataByUrl.get(absolute(src, base) ?? '');
		if (data) img.setAttribute('src', data);
	}
	// Rewrite baked background urls (inline style mirrors the baked map).
	for (const [clone, baked] of captured.bakedStyles) {
		for (const prop of BG_PROPS) {
			const value = baked.get(prop);
			if (!value || !value.includes('url(')) continue;
			const rewritten = rewriteUrls(value, base, dataByUrl);
			if (rewritten === value) continue;
			baked.set(prop, rewritten);
			try {
				(clone as HTMLElement).style.setProperty(prop, rewritten);
			} catch {
				// Invalid for this element; the baked-map entry still ships to emit.
			}
		}
	}

	dropUncontainedFaces(captured);
}

/**
 * Drops any @font-face the inlining could not make self-contained, so the artifact never
 * ships a dead origin reference. A face whose src resolves only to an external url (no
 * data: bytes inlined and no local() system source) cannot render once the snip is pasted
 * away from the origin, and appendGenericFallbacks has already guaranteed every baked
 * font-family stack ends in a generic, so the text falls back deterministically rather
 * than depending on (or 404ing from) the origin.
 *
 * This is the closing guard for the resource path: whatever the recovery and inlining
 * steps could not carry is corrected to a clean fallback here, never left to break, and
 * the standalone resource probe still counts the family as unresolved so the loss stays
 * visible. Only un-inlinable faces are removed, so a fully inlined corpus is untouched.
 *
 * @param captured - captured.fonts is filtered in place
 */
function dropUncontainedFaces(captured: Captured): void {
	const contained = captured.fonts.filter((font) => isSelfContained(font.src));
	if (contained.length === captured.fonts.length) return;
	captured.warnings.push(
		`inline: dropped ${captured.fonts.length - contained.length} font face(s) that could not be made self-contained; their text falls back to a generic`,
	);
	captured.fonts = contained;
}

/**
 * Whether a @font-face src can render without the origin: it has no external url at all
 * (data:, local(), or already resolved), or it pairs an external url with an inlined
 * data: source or a local() system fallback the browser can use offline.
 *
 * @param src - the face's src descriptor
 */
function isSelfContained(src: string): boolean {
	if (!/url\(\s*['"]?https?:/i.test(src)) return true; // No external url to depend on.
	return /url\(\s*['"]?data:/i.test(src) || /\blocal\(/i.test(src);
}

/** Every <img> in the snip subtree, including the root when it is itself an image. */
function collectImages(clone: Element): HTMLImageElement[] {
	const imgs = Array.from(clone.querySelectorAll('img')) as HTMLImageElement[];
	if (clone.tagName === 'IMG') imgs.push(clone as HTMLImageElement);
	return imgs;
}

/** Fetches every url through the background broker, bounded by FETCH_CONCURRENCY. */
async function fetchAll(urls: string[]): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < urls.length) {
			const url = urls[next++];
			if (!url) continue;
			const dataUrl = await fetchData(url);
			if (dataUrl) out.set(url, dataUrl);
		}
	};
	await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, urls.length) }, worker));
	return out;
}

/**
 * Fetches one url as a data uri, null on any failure or timeout. Tries a direct fetch
 * from the content script first (which succeeds for same-origin and cors-enabled
 * resources without a worker round-trip), then falls back to the privileged background
 * broker, whose <all_urls> permission reaches cross-origin and hotlink-protected
 * resources the page's own context cannot.
 */
async function fetchData(url: string): Promise<string | null> {
	const direct = await fetchDataDirect(url);
	if (direct) return direct;
	return fetchDataViaBackground(url);
}

/** Direct content-script fetch + encode; null if blocked (cors), oversize, or non-2xx. */
async function fetchDataDirect(url: string): Promise<string | null> {
	try {
		const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
		if (!res.ok) return null;
		const blob = await res.blob();
		if (blob.size > MAX_INLINE_BYTES) return null;
		return await blobToDataUrl(blob);
	} catch {
		return null;
	}
}

/** Background-broker fetch (privileged); null on failure or timeout. */
async function fetchDataViaBackground(url: string): Promise<string | null> {
	try {
		const reply = (await Promise.race([
			chrome.runtime.sendMessage({ type: 'FETCH_BINARY', requestId: crypto.randomUUID(), payload: { url } }),
			new Promise((resolve) => setTimeout(() => resolve(null), FETCH_TIMEOUT_MS)),
		])) as { ok?: boolean; result?: { dataUrl?: string } } | null;
		return reply?.ok && reply.result?.dataUrl ? reply.result.dataUrl : null;
	} catch {
		return null;
	}
}

/** Reads a blob into a base64 data uri. */
function blobToDataUrl(blob: Blob): Promise<string | null> {
	return new Promise((resolve) => {
		const reader = new FileReader();
		reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
		reader.onerror = () => resolve(null);
		reader.readAsDataURL(blob);
	});
}

/** Every url() target inside a css value (font src may list several). */
function urlsIn(value: string): string[] {
	const out: string[] = [];
	for (const match of value.matchAll(URL_IN_VALUE)) {
		const url = match[2];
		if (url) out.push(url);
	}
	return out;
}

/** Rewrites each url() in a value to its data uri when one was fetched, else leaves it. */
function rewriteUrls(value: string, base: string, dataByUrl: Map<string, string>): string {
	return value.replace(URL_IN_VALUE, (match, quote: string, url: string) => {
		if (url.startsWith('data:')) return match;
		const data = dataByUrl.get(absolute(url, base) ?? '');
		return data ? `url(${quote}${data}${quote})` : match;
	});
}

/** Resolve a possibly-relative url against the base; null if unparseable. */
function absolute(url: string, base: string): string | null {
	try {
		return new URL(url, base).href;
	} catch {
		return null;
	}
}
