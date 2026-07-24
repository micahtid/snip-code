/**
 * convert/assets.ts: split inline svgs, data-uri images, and data-uri fonts into referenced files
 *
 * Pipeline position: convert. This is a delivery-time split, after the document is assembled.
 * Reads from Captured: nothing. It operates on the assembled document string.
 * Writes to Captured: nothing. It returns the file set.
 *
 * Why this exists: the html-shaped output is one self-contained document with its
 * svg icons, data-uri images, and @font-face fonts inlined. That renders and grades as
 * a single file, but it is hard to read and reuse. A 30-line icon sits in the middle of
 * the markup, a base64 image is an unreadable wall, and an embedded font is hundreds of
 * KB that dwarf the stylesheet a user actually reads. This lifts each inline <svg>, each
 * data: image, and each @font-face src font into its own file and rewrites the document
 * to reference it (<img src="icon-1.svg">, url("image-1.png"), url("font-1.woff2")), so
 * the sidebar can present them as separate, switchable files. The caller keeps the
 * original self-contained document for preview and grading. This split is purely the
 * user-facing delivery shape.
 *
 * Render fidelity: an svg loaded through <img> no longer inherits the page's color.
 * So each icon's currentColor is resolved by laying the document out in a hidden
 * iframe and reading the svg's computed color. That computed color is ground truth
 * whether it is set inline, by a presentation attribute, or by a class rule, so it is
 * correct for every output format, and it is baked into the file before the icon is
 * detached. The same computed box, its size, display, and vertical-align, carries onto
 * the replacement <img> so it lays out where the svg did. An svg taken out of normal
 * flow by a non-static position or a transform cannot be reproduced by an in-flow <img>,
 * so it is left inline. The same goes for a sprite whose <use> points outside itself.
 * What lifts is faithful. What would not stays put.
 */
import type { AssetFile } from '../types';

/** The color an icon falls back to when nothing in its ancestry sets one. */
const DEFAULT_COLOR = '#000000';

/**
 * An svg that composes through references, a mask, a filter, a <use> of defs, or a
 * <foreignObject>, cannot be trusted to paint the same once detached into a standalone
 * <img>, so it is left inline. Simple shape-and-path icons carry no such construct and lift
 * faithfully.
 */
const COMPOSES_VIA_REFERENCE = /<(?:use|mask|filter|foreignObject)\b/i;

/** Data-uri images referenced by an attribute, img src or use href, or by css url(). */
const DATA_IMG_ATTR = /(\b(?:src|href)\s*=\s*)(["'])(data:image\/[^"']+)\2/gi;
const DATA_IMG_URL = /url\(\s*(["']?)(data:image\/[^"')]+)\1\s*\)/gi;

/**
 * Splits an assembled html document into its index file plus one file per inline
 * svg and data-uri image. Identical assets dedupe to a single shared file. On any
 * failure the document is returned whole as the only file, so the panel always has
 * something to show.
 *
 * The document's inline stylesheet is lifted out last, into styles.css referenced by a
 * <link>, so the css a user reads is a file of its own rather than a block buried in the
 * markup. It runs last because the earlier passes rewrite url() references inside it.
 *
 * @param documentHtml - the self-contained html-shaped output
 * @param warnings - appended to if the split is skipped
 * @returns index.html, then styles.css, then the extracted svg/image files in encounter order
 */
export function splitAssets(documentHtml: string, warnings: string[]): AssetFile[] {
	try {
		const assets: AssetFile[] = [];
		const fileByContent = new Map<string, string>(); // Identical content reuses one file
		let svgCount = 0;
		let imageCount = 0;
		let fontCount = 0;

		const boxes = resolveSvgBoxes(documentHtml);
		let svgIndex = 0;
		let html = extractSvgs(documentHtml, (svg) => {
			const box = boxes[svgIndex++];
			// An icon pointing at a fragment defined outside itself, a shared sprite via
			// <use href="#id">, would lose its target once detached, so keep it inline.
			if (referencesExternalFragment(svg)) return svg;
			// An svg positioned or transformed out of normal flow (a decorative graphic that
			// bleeds past its container) cannot be reproduced by an in-flow <img> without
			// carrying its full positioning context, so keep it inline where it lays out right.
			if (box && (box.position !== 'static' || box.transform !== 'none')) return svg;
			// An svg that composes cross-references, a <mask>/<filter>, a <use> pointing at defs,
			// or a <foreignObject>, renders through the document that hosts it. Detached into a
			// standalone <img> those either break or paint differently, so keep it inline.
			if (COMPOSES_VIA_REFERENCE.test(svg)) return svg;
			const file = bakeColor(ensureXmlns(svg), box?.color ?? DEFAULT_COLOR);
			const name = register(assets, fileByContent, file, () => `icon-${++svgCount}.svg`, 'svg', { text: file });
			return buildImgTag(svg, name, box);
		});

		html = extractDataUris(html, (dataUrl) =>
			register(assets, fileByContent, dataUrl, () => `image-${++imageCount}.${mimeExtension(dataUrl)}`, 'image', { dataUrl }),
		);

		// Fonts are the bulk of the stylesheet's bytes: a single @font-face src data uri can be
		// hundreds of KB. Lift each to its own file the way images are lifted, so the css a user
		// reads shrinks to the @font-face rule plus a short relative url.
		html = extractFontUris(html, (dataUrl, ext) =>
			register(assets, fileByContent, dataUrl, () => `font-${++fontCount}.${ext}`, 'font', { dataUrl }),
		);

		const { html: linked, css } = splitStylesheet(html, warnings);
		const index: AssetFile = { name: 'index.html', language: 'html', text: linked };
		const sheet: AssetFile[] = css === null ? [] : [{ name: STYLESHEET_NAME, language: 'css', text: css }];
		return [index, ...sheet, ...assets];
	} catch (err) {
		warnings.push(`asset split skipped: ${(err as Error).message}`);
		return [{ name: 'index.html', language: 'html', text: documentHtml }];
	}
}

/** The lifted stylesheet's file name, referenced relatively so it resolves beside index.html. */
const STYLESHEET_NAME = 'styles.css';

/** The document's single inline stylesheet, captured with its contents. */
const STYLE_BLOCK = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;

/**
 * Lifts the document's one inline <style> block into a separate stylesheet, leaving a <link>
 * in its place. The pipeline composes exactly one style block, so anything else means the
 * document is not the shape this understands and is left whole rather than half-rewritten,
 * matching how the asset split degrades. The self-contained document the caller keeps for
 * preview and grading is untouched: only the delivered file set is rewritten here.
 *
 * @param html - the document, already asset-split
 * @param warnings - appended to when the lift is skipped
 * @returns the linked document, and the lifted css, or null when nothing was lifted
 */
function splitStylesheet(html: string, warnings: string[]): { html: string; css: string | null } {
	const blocks = [...html.matchAll(STYLE_BLOCK)];
	if (blocks.length !== 1) {
		if (blocks.length > 1) warnings.push('stylesheet split skipped: the document has more than one style block');
		return { html, css: null };
	}
	const block = blocks[0]!;
	const css = (block[1] ?? '').trim();
	if (!css) return { html, css: null };
	const linked = html.slice(0, block.index) + `<link rel="stylesheet" href="${STYLESHEET_NAME}">` + html.slice(block.index + block[0].length);
	return { html: linked, css: `${css}\n` };
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
		if (end === -1) break; // Unbalanced, so leave the remainder verbatim
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
function buildImgTag(svg: string, name: string, box: SvgBox | undefined): string {
	const el = new DOMParser().parseFromString(svg, 'text/html').querySelector('svg');
	if (!el) return `<img src="${name}" alt="">`;
	const style = imgStyle(el, box);
	const alt = el.getAttribute('aria-label') ?? el.querySelector('title')?.textContent ?? '';
	const hidden = el.getAttribute('aria-hidden') === 'true' ? ' aria-hidden="true"' : '';
	return `<img src="${name}"${style ? ` style="${escapeAttr(style)}"` : ''}${hidden} alt="${escapeAttr(alt)}">`;
}

/**
 * The box styles the <img> needs to lay out exactly where the inline svg did, minus the
 * now-baked paint props. The svg's size, display, and baseline can come from an attribute, an
 * inline style, or a class rule. Only the computed box (`box`) captures all three, so it is
 * the ground truth for those. Any other box props authored inline, a margin say, are kept as
 * written. `display`/`vertical-align` are emitted only when they deviate from the <img>
 * defaults (inline, baseline), so a plain icon stays clean.
 */
function imgStyle(el: Element, box: SvgBox | undefined): string {
	const decls: string[] = [];
	for (const part of (el.getAttribute('style') ?? '').split(';')) {
		const colon = part.indexOf(':');
		if (colon === -1) continue;
		const prop = part.slice(0, colon).trim().toLowerCase();
		// Paint is baked into the file. Size, display, and baseline come from the computed box.
		if (!prop || ['fill', 'stroke', 'color', 'width', 'height', 'display', 'vertical-align'].includes(prop)) continue;
		decls.push(`${prop}: ${part.slice(colon + 1).trim()}`);
	}
	if (box) {
		if (box.display !== 'inline') decls.push(`display: ${box.display}`);
		if (box.verticalAlign !== 'baseline') decls.push(`vertical-align: ${box.verticalAlign}`);
		if (box.width !== 'auto') decls.push(`width: ${box.width}`);
		if (box.height !== 'auto') decls.push(`height: ${box.height}`);
	}
	return decls.join('; ');
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
// Data-uri font extraction
// ---------------------------------------------------------------------------

/**
 * A css url() carrying a data uri, with the optional format() hint that follows it in an
 * @font-face src. The capture groups are the opening quote, the data uri, the whole
 * format() span to preserve, and the hint token, in that order. This runs after image
 * extraction, so any remaining data uri in a url() is a font or another non-image asset,
 * which the mime check below filters.
 */
const DATA_FONT_URL = /url\(\s*(["']?)(data:[^"')]+)\1\s*\)(\s*format\(\s*["']?([\w+-]+)["']?\s*\))?/gi;

/** The extension for a font mime type: one reliable signal a data uri carries a font. */
const FONT_MIME_EXT: Record<string, string> = {
	'font/woff2': 'woff2', 'font/woff': 'woff', 'font/ttf': 'ttf', 'font/truetype': 'ttf',
	'font/otf': 'otf', 'font/opentype': 'otf', 'font/sfnt': 'ttf',
	'application/font-woff2': 'woff2', 'application/font-woff': 'woff', 'application/x-font-woff': 'woff',
	'application/font-sfnt': 'ttf', 'application/x-font-ttf': 'ttf', 'application/x-font-truetype': 'ttf',
	'application/x-font-opentype': 'otf', 'application/vnd.ms-fontobject': 'eot',
};

/** The extension for a format() hint, the fallback when the mime is generic (octet-stream). */
const FONT_HINT_EXT: Record<string, string> = { woff2: 'woff2', woff: 'woff', truetype: 'ttf', opentype: 'otf', 'embedded-opentype': 'eot', svg: 'svg' };

/** The extension for a font's magic bytes, the ground truth beneath any declared mime. */
const FONT_SIGNATURE_EXT: Record<string, string> = { wOF2: 'woff2', wOFF: 'woff', OTTO: 'otf', true: 'ttf', typ1: 'ttf', ttcf: 'ttc', '\x00\x01\x00\x00': 'ttf' };

/**
 * Replaces each @font-face src data-uri font in a css url() with the filename `replace`
 * returns, passing the resolved extension, and preserves the format() hint that follows.
 * A url() whose data uri is not a font, an image the earlier pass missed, is left untouched.
 */
function extractFontUris(html: string, replace: (dataUrl: string, ext: string) => string): string {
	return html.replace(DATA_FONT_URL, (whole, quote: string, dataUrl: string, formatSpan: string | undefined, hint: string | undefined) => {
		const mime = (/^data:([^;,]*)/i.exec(dataUrl)?.[1] ?? '').toLowerCase();
		const ext = fontExtension(dataUrl, mime, hint);
		if (!ext) return whole; // Not a font data uri, so leave it as written.
		return `url(${quote}${replace(dataUrl, ext)}${quote})${formatSpan ?? ''}`;
	});
}

/**
 * The file extension for a font data uri, or null when the uri is not a font. The font's own
 * magic bytes are the ground truth and are read first, so a mislabeled uri (a woff2 served as
 * binary/octet-stream) is still recognized. The declared mime and then the format() hint are
 * fallbacks for a container, eot say, whose header carries no clean signature.
 */
function fontExtension(dataUrl: string, mime: string, hint: string | undefined): string | null {
	const bySignature = fontSignatureExt(dataUrl);
	if (bySignature) return bySignature;
	if (FONT_MIME_EXT[mime]) return FONT_MIME_EXT[mime];
	if (/^font\//.test(mime)) return 'woff2'; // A font/* subtype we do not enumerate, so woff2 is the modern default.
	const hinted = hint ? FONT_HINT_EXT[hint.toLowerCase()] : undefined;
	if (hinted && (mime === 'application/octet-stream' || mime === 'binary/octet-stream' || mime === '')) return hinted;
	return null;
}

/** The extension implied by a base64 data uri's first four decoded bytes, or null. */
function fontSignatureExt(dataUrl: string): string | null {
	const head = /;base64,([A-Za-z0-9+/]{8})/.exec(dataUrl)?.[1];
	if (!head) return null;
	try {
		return FONT_SIGNATURE_EXT[atob(head).slice(0, 4)] ?? null;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** The computed box a top-level svg occupies, the ground truth the replacement <img> matches. */
interface SvgBox {
	color: string; // Resolved currentColor, baked into the detached file
	display: string;
	verticalAlign: string;
	width: string; // Used width in px, or 'auto'
	height: string;
	position: string; // Non-static or a transform means the svg is out of normal flow
	transform: string;
}

/**
 * The computed box each top-level svg renders with, in document order, read from the
 * document laid out in a hidden same-origin iframe. getComputedStyle resolves color, size,
 * display, and baseline however they are set, whether inline, by a presentation attribute, or
 * by a class rule, so the replacement <img> matches for every output format. Returns fewer
 * entries, so callers fall back to defaults, if the document cannot be laid out.
 */
function resolveSvgBoxes(documentHtml: string): SvgBox[] {
	const boxes: SvgBox[] = [];
	const frame = document.createElement('iframe');
	frame.setAttribute('aria-hidden', 'true');
	frame.setAttribute('sandbox', 'allow-same-origin'); // Lay the markup out, but never run its scripts
	frame.style.cssText = 'position:absolute;left:-99999px;top:0;width:0;height:0;border:0;visibility:hidden';
	document.body.appendChild(frame);
	try {
		const doc = frame.contentDocument;
		const win = frame.contentWindow;
		if (!doc || !win) return boxes;
		doc.open();
		doc.write(documentHtml);
		doc.close();
		for (const svg of doc.querySelectorAll('svg')) {
			if (!isTopLevelSvg(svg)) continue;
			const cs = win.getComputedStyle(svg);
			boxes.push({ color: cs.color || DEFAULT_COLOR, display: cs.display, verticalAlign: cs.verticalAlign, width: cs.width, height: cs.height, position: cs.position, transform: cs.transform });
		}
	} catch {
		// Layout unavailable, so callers fall back to defaults.
	} finally {
		frame.remove();
	}
	return boxes;
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
