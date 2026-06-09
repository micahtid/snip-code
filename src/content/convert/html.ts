/**
 * convert/html.ts — plain html + css output
 *
 * Phase: e (convert) — see SNIPCODE-REWRITE-PLAN.md section 12
 * Pipeline position: 4 — convert
 * Reads from Captured: clone (inline-styled), fonts, keyframes
 * Writes to Captured: nothing (pure emitter; returns the output)
 *
 * Principles applied: none directly; emits the reconciled+resolved result.
 *
 * Why this exists: the "html" output format (decision 10) is the baseline self-
 * contained form: the inline-styled markup plus a <style> block carrying the
 * pieces that cannot live inline — @font-face and @keyframes. (:root custom
 * properties were already inlined onto the snip root by resolve/vars.ts.) every
 * other format (tailwind, bem, jsx, vue) is a transform of this same baked
 * clone. composeDocument() is what the grader renders as output.html (commit 17).
 */
import type { Captured } from '../types';

/** the emitted html + the stylesheet text that must accompany it. */
export interface HtmlOutput {
	html: string;
	css: string;
}

/**
 * emits the inline-styled clone as html plus a css block of @font-face and
 * @keyframes (the rules that cannot be expressed inline).
 *
 * @param captured — reads the resolved clone, fonts, keyframes
 */
export function emitHtml(captured: Captured): HtmlOutput {
	const parts: string[] = [];
	for (const font of captured.fonts) parts.push(fontFaceText(font));
	for (const kf of captured.keyframes) parts.push(`@keyframes ${kf.name} {\n${kf.rules}\n}`);
	return { html: captured.clone.outerHTML, css: parts.join('\n\n') };
}

/**
 * composes a single self-contained html document string from the markup and its
 * stylesheet. this is what renders standalone (and what the grader screenshots).
 *
 * @param html — the inline-styled markup
 * @param css — the accompanying @font-face / @keyframes block (may be empty)
 */
export function composeDocument(html: string, css: string): string {
	return css.trim() ? `<style>\n${css}\n</style>\n${html}` : html;
}

/** serialize one @font-face with its family, src, and all descriptors. */
function fontFaceText(font: Captured['fonts'][number]): string {
	const descriptors = Object.entries(font.descriptors)
		.map(([k, v]) => `\t${k}: ${v};`)
		.join('\n');
	return `@font-face {\n\tfont-family: "${font.family}";\n\tsrc: ${font.src};${descriptors ? '\n' + descriptors : ''}\n}`;
}
