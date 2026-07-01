/**
 * convert/assets.ts: split inline svgs + data-uri images into referenced files
 *
 * Pipeline position: convert; a delivery-time split, after the document is assembled
 * Reads from Captured: nothing; operates on the assembled document string
 * Writes to Captured: nothing; returns the file set
 *
 * Why this exists: the html-shaped output is one self-contained document with its
 * svg icons and any data-uri images inlined. That renders and grades as a single
 * file, but it is hard to read and reuse: a 30-line icon sits in the middle of the
 * markup and a base64 image is an unreadable wall. This lifts each inline <svg> and
 * each data: image into its own file and rewrites the document to reference it
 * (<img src="icon-1.svg">, url("image-1.png")), so the sidebar can present them as
 * separate, switchable files. The caller keeps the original self-contained document
 * for preview and grading; this split is purely the user-facing delivery shape.
 *
 * Render fidelity: an svg loaded through <img> no longer inherits the page's color,
 * so each icon's currentColor is resolved by laying the document out in a hidden
 * iframe and reading the svg's computed color, which is ground truth whether the color is set
 * inline, by a presentation attribute, or by a class rule, so it is correct for every
 * output format, and baked into the file before the icon is detached. The svg's box
 * styles, its size, display, and vertical-align, carry onto the replacement <img>.
 */
import type { AssetFile } from '../types';

/** The color an icon falls back to when nothing in its ancestry sets one. */
const DEFAULT_COLOR = '#000000';

/** Data-uri images referenced by an attribute, img src or use href, or by css url(). */
const DATA_IMG_ATTR = /(\b(?:src|href)\s*=\s*)(["'])(data:image\/[^"']+)\2/gi;
const DATA_IMG_URL = /url\(\s*(["']?)(data:image\/[^"')]+)\1\s*\)/gi;

/**
 * Splits an assembled html document into its index file plus one file per inline
 * svg and data-uri image. Identical assets dedupe to a single shared file. On any
 * failure the document is returned whole as the only file, so the panel always has
 * something to show.
 *
 * @param documentHtml - the self-contained html-shaped output
 * @param warnings - appended to if the split is skipped
 * @returns index.html first, then the extracted svg/image files in encounter order
 */
export function splitAssets(documentHtml: string, warnings: string[]): AssetFile[] {
	try {
		const assets: AssetFile[] = [];
		const fileByContent = new Map<string, string>(); // Identical content reuses one file
		let svgCount = 0;
		let imageCount = 0;

		const colors = resolveSvgColors(documentHtml);
		let svgIndex = 0;
		let html = extractSvgs(documentHtml, (svg) => {
			const color = colors[svgIndex++] ?? DEFAULT_COLOR;
			// An icon pointing at a fragment defined outside itself, a shared sprite via
			// <use href="#id">, would lose its target once detached, so keep it inline.
			if (referencesExternalFragment(svg)) return svg;
			const file = bakeColor(ensureXmlns(svg), color);
			const name = register(assets, fileByContent, file, () => `icon-${++svgCount}.svg`, 'svg', { text: file });
			return buildImgTag(svg, name);
		});

		html = extractDataUris(html, (dataUrl) =>
			register(assets, fileByContent, dataUrl, () => `image-${++imageCount}.${mimeExtension(dataUrl)}`, 'image', { dataUrl }),
		);

		return [{ name: 'index.html', language: 'html', text: html }, ...assets];
	} catch (err) {
		warnings.push(`asset split skipped: ${(err as Error).message}`);
		return [{ name: 'index.html', language: 'html', text: documentHtml }];
	}
}

/** Records an asset, deduped by content, and returns the filename to reference it by. */
function register(
	assets: AssetFile[],
	fileByContent: Map<string, string>,
	content: string,
	makeName: () => string,
	language: AssetFile['language'],
	payload: Pick<AssetFile, 'text' | 'dataUrl'>,
): string {
	const existing = fileByContent.get(content);
	if (existing) return existing;
	const name = makeName();
	fileByContent.set(content, name);
	assets.push({ name, language, ...payload });
	return name;
}

// ---------------------------------------------------------------------------
// Inline svg extraction
// ---------------------------------------------------------------------------

/**
 * Replaces each top-level inline <svg>...</svg> with the string `replace` returns
 * for it, leaving the surrounding markup, and its formatting, untouched. Nested
 * svgs travel inside their top-level parent, so only the outermost is replaced.
 */
function extractSvgs(html: string, replace: (svg: string) => string): string {
	let result = '';
	let i = 0;
	let start: number;
	while ((start = nextSvgStart(html, i)) !== -1) {
		const end = matchingSvgEnd(html, start);
		if (end === -1) break; // Unbalanced; leave the remainder verbatim
		result += html.slice(i, start) + replace(html.slice(start, end));
		i = end;
	}
	return result + html.slice(i);
}

/** The index of the next real `<svg` tag at or after `from`, skipping `<svgfoo`-style false hits. */
function nextSvgStart(html: string, from: number): number {
	let at = html.indexOf('<svg', from);
	while (at !== -1 && !isSvgTagStart(html, at)) at = html.indexOf('<svg', at + 4);
	return at;
}

/** The index just past the `</svg>` that closes the svg opening at `start`, or -1 if unbalanced. */
function matchingSvgEnd(html: string, start: number): number {
	let depth = 0;
	let i = start;
	while (i < html.length) {
		const close = html.indexOf('</svg>', i);
		if (close === -1) return -1;
		let open = html.indexOf('<svg', i);
		while (open !== -1 && open < close && !isSvgTagStart(html, open)) open = html.indexOf('<svg', open + 4);
		if (open !== -1 && open < close) {
			depth++;
			i = open + 4;
		} else {
			depth--;
			i = close + 6;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/** True when `<svg` at `pos` begins a tag, meaning the next char ends the name, rather than a longer word. */
function isSvgTagStart(html: string, pos: number): boolean {
	const next = html[pos + 4];
	return next === undefined || next === '>' || next === '/' || /\s/.test(next);
}

/** Replaces currentColor, in any case, with a concrete color so the detached icon keeps it. */
function bakeColor(svg: string, color: string): string {
	return svg.replace(/currentcolor/gi, color);
}

/** True when the svg references a fragment by #id, for example a sprite <use href="#id">, that it does not define itself. */
function referencesExternalFragment(svg: string): boolean {
	const ids = (re: RegExp) => [...svg.matchAll(re)].map((m) => m[1]).filter((id): id is string => id !== undefined);
	const referenced = ids(/href\s*=\s*["']#([\w:.-]+)["']/gi);
	if (referenced.length === 0) return false;
	const defined = new Set(ids(/\sid\s*=\s*["']([\w:.-]+)["']/gi));
	return referenced.some((id) => !defined.has(id));
}

/** Adds the svg namespace to the root tag if absent, so the file renders standalone. */
function ensureXmlns(svg: string): string {
	const tagEnd = svg.indexOf('>');
	if (tagEnd === -1 || /\sxmlns\s*=/.test(svg.slice(0, tagEnd))) return svg;
	return `<svg xmlns="http://www.w3.org/2000/svg"${svg.slice(4)}`;
}

/** Builds the <img> that replaces an inline svg, carrying its box styles and label. */
function buildImgTag(svg: string, name: string): string {
	const el = new DOMParser().parseFromString(svg, 'text/html').querySelector('svg');
	if (!el) return `<img src="${name}" alt="">`;
	const style = sizingStyle(el);
	const alt = el.getAttribute('aria-label') ?? el.querySelector('title')?.textContent ?? '';
	const hidden = el.getAttribute('aria-hidden') === 'true' ? ' aria-hidden="true"' : '';
	return `<img src="${name}"${style ? ` style="${escapeAttr(style)}"` : ''}${hidden} alt="${escapeAttr(alt)}">`;
}

/** The svg's box styles, such as size and display, for the <img>, minus the now-baked paint props. */
function sizingStyle(el: Element): string {
	const decls: string[] = [];
	for (const part of (el.getAttribute('style') ?? '').split(';')) {
		const colon = part.indexOf(':');
		if (colon === -1) continue;
		const prop = part.slice(0, colon).trim().toLowerCase();
		if (!prop || prop === 'fill' || prop === 'stroke' || prop === 'color') continue; // Paint is baked into the file
		decls.push(`${prop}: ${part.slice(colon + 1).trim()}`);
	}
	if (!decls.some((d) => d.startsWith('width')) && el.getAttribute('width')) decls.push(`width: ${cssLength(el.getAttribute('width')!)}`);
	if (!decls.some((d) => d.startsWith('height')) && el.getAttribute('height')) decls.push(`height: ${cssLength(el.getAttribute('height')!)}`);
	return decls.join('; ');
}

/** A bare number is css pixels; anything with a unit (1em, 20px) passes through. */
function cssLength(value: string): string {
	const v = value.trim();
	return /^\d+(?:\.\d+)?$/.test(v) ? `${v}px` : v;
}

// ---------------------------------------------------------------------------
// Data-uri image extraction
// ---------------------------------------------------------------------------

/** Replaces each data:image uri, in src/href attrs and css url(), with the filename `replace` returns. */
function extractDataUris(html: string, replace: (dataUrl: string) => string): string {
	return html
		.replace(DATA_IMG_ATTR, (_m, prefix: string, quote: string, dataUrl: string) => `${prefix}${quote}${replace(dataUrl)}${quote}`)
		.replace(DATA_IMG_URL, (_m, quote: string, dataUrl: string) => `url(${quote}${replace(dataUrl)}${quote})`);
}

/** The file extension for a data:image uri (svg+xml -> svg, jpeg -> jpg). */
function mimeExtension(dataUrl: string): string {
	const subtype = (/^data:image\/([a-z0-9.+-]+)/i.exec(dataUrl)?.[1] ?? 'png').toLowerCase();
	if (subtype === 'svg+xml') return 'svg';
	if (subtype === 'jpeg') return 'jpg';
	return subtype.replace(/[^a-z0-9]/g, '') || 'png';
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * The color each top-level svg renders with, in document order, read from the
 * document laid out in a hidden same-origin iframe. getComputedStyle resolves
 * currentColor however the color is set, whether inline, by a presentation attribute, or by a class
 * rule, so it is correct for every output format. Returns fewer entries, so callers
 * fall back to DEFAULT_COLOR, if the document cannot be laid out.
 */
function resolveSvgColors(documentHtml: string): string[] {
	const colors: string[] = [];
	const frame = document.createElement('iframe');
	frame.setAttribute('aria-hidden', 'true');
	frame.setAttribute('sandbox', 'allow-same-origin'); // Lay the markup out, but never run its scripts
	frame.style.cssText = 'position:absolute;left:-99999px;top:0;width:0;height:0;border:0;visibility:hidden';
	document.body.appendChild(frame);
	try {
		const doc = frame.contentDocument;
		const win = frame.contentWindow;
		if (!doc || !win) return colors;
		doc.open();
		doc.write(documentHtml);
		doc.close();
		for (const svg of doc.querySelectorAll('svg')) {
			if (isTopLevelSvg(svg)) colors.push(win.getComputedStyle(svg).color || DEFAULT_COLOR);
		}
	} catch {
		// Layout unavailable; callers fall back to DEFAULT_COLOR.
	} finally {
		frame.remove();
	}
	return colors;
}

/** True when no ancestor of `svg` is itself an svg, so it is one we extract. */
function isTopLevelSvg(svg: Element): boolean {
	for (let p = svg.parentElement; p; p = p.parentElement) if (p.tagName.toLowerCase() === 'svg') return false;
	return true;
}

/** Escapes the characters unsafe inside a double-quoted html attribute value. */
function escapeAttr(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
