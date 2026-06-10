/**
 * convert/vue.ts: vue single-file component output
 *
 * Phase: e (convert), see SNIPCODE-REWRITE-PLAN.md section 12
 * Pipeline position: 4, convert
 * Reads from Captured: clone (via the bem emitter)
 * Writes to Captured: nothing
 *
 * Principles applied: none directly; a format transform of the baked result.
 *
 * Why this exists: the vue format (decision 10) emits a single-file component.
 * vue templates are html (class stays class, unlike jsx), so this reuses the
 * bem-css emitter for class-based markup and a stylesheet, then wraps the markup
 * in <template> and the css in <style scoped>. a vue template needs one root
 * element, which the snip root provides.
 */
import type { Captured } from '../types';
import { emitBem } from './bem';
import type { HtmlOutput } from './html';

/**
 * emits the snip as a vue sfc string (template + scoped style).
 *
 * @param captured - read-only
 * @returns html = the .vue file contents; css = the stylesheet (also embedded)
 */
export function emitVue(captured: Captured): HtmlOutput {
	const base = emitBem(captured, false);
	const template = indent(base.html, 1);
	const style = base.css.trim() ? `\n\n<style scoped>\n${base.css}\n</style>` : '';
	const sfc = `<template>\n${template}\n</template>${style}`;
	return { html: sfc, css: base.css };
}

/** indent every line of `text` by `levels` tabs. */
function indent(text: string, levels: number): string {
	const pad = '\t'.repeat(levels);
	return text
		.split('\n')
		.map((line) => (line ? pad + line : line))
		.join('\n');
}
