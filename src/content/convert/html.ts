/**
 * convert/html.ts: plain html + css output
 *
 * Pipeline position: convert
 * Reads from Captured: the inline-styled clone, fonts, and keyframes
 * Writes to Captured: nothing; a pure emitter that returns the output
 *
 * Emits the reconciled and resolved result.
 *
 * Why this exists: the "html" output format is the baseline self-
 * contained form: the inline-styled markup plus a <style> block carrying the
 * pieces that cannot live inline, @font-face and @keyframes. The :root custom
 * properties were already inlined onto the snip root by resolve/vars.ts. Every
 * other format, whether tailwind, bem, jsx, or vue, is a transform of this same baked
 * clone. composeDocument() is what the grader renders as output.html.
 */
import type { Captured } from '../types';

/** The emitted html + the stylesheet text that must accompany it. */
export interface HtmlOutput {
	html: string;
	css: string;
}

/**
 * Emits the inline-styled clone as html plus a css block of @font-face and
 * @keyframes, the rules that cannot be expressed inline.
 *
 * @param captured - reads the resolved clone, fonts, keyframes
 */
export function emitHtml(captured: Captured): HtmlOutput {
	return { html: captured.clone.outerHTML, css: atRulesCss(captured) };
}

/**
 * Builds the @font-face + @keyframes stylesheet block shared by every emitter;
 * these at-rules cannot be expressed inline or as utility classes.
 *
 * @param captured - reads fonts + keyframes
 */
export function atRulesCss(captured: Captured): string {
	const parts: string[] = [];
	for (const font of captured.fonts) parts.push(fontFaceText(font));
	for (const kf of captured.keyframes) parts.push(`@keyframes ${kf.name} {\n${kf.rules}\n}`);
	return parts.join('\n\n');
}

/**
 * The standalone document's base reset. Only the document-edge margin a user-agent
 * adds to <body> (8px) is zeroed, so the snip sits flush at the origin the way a
 * pasted component should, rather than shoved in by phantom margin it never authored.
 * Deliberately minimal: no box-sizing or typography reset, which would change how the
 * baked styles render. The snip's own margins/padding are baked inline and untouched.
 */
const BASE_RESET = 'html, body { margin: 0; padding: 0; }';

/**
 * Composes a single self-contained html document from the markup and its stylesheet.
 * Emits a valid standalone document, with doctype, charset, and head/body, so the artifact does
 * not depend on the origin and renders identically wherever it is pasted. This is what
 * renders standalone, and what the grader screenshots.
 *
 * @param html - the inline-styled markup
 * @param css - the accompanying @font-face / @keyframes block, which may be empty
 */
export function composeDocument(html: string, css: string): string {
	const sheet = [BASE_RESET, css.trim()].filter(Boolean).join('\n\n');
	return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<style>\n${sheet}\n</style>\n</head>\n<body>\n${html}\n</body>\n</html>`;
}

/** Serialize one @font-face with its family, src, and all descriptors. */
function fontFaceText(font: Captured['fonts'][number]): string {
	const descriptors = Object.entries(font.descriptors)
		.map(([k, v]) => `\t${k}: ${v};`)
		.join('\n');
	return `@font-face {\n\tfont-family: "${font.family}";\n\tsrc: ${font.src};${descriptors ? '\n' + descriptors : ''}\n}`;
}
