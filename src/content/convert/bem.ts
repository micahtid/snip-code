/**
 * convert/bem.ts — inline styles -> bem classes + css/scss
 *
 * Phase: e (convert) — see SNIPCODE-REWRITE-PLAN.md section 12
 * Pipeline position: 4 — convert
 * Reads from Captured: clone (inline-styled)
 * Writes to Captured: nothing (deep-copies the clone; canonical clone untouched)
 *
 * Principles applied: none directly; a format transform of the baked result.
 *
 * Why this exists: the bem-css and bem-scss formats (decision 10) want semantic
 * classes and a separate stylesheet instead of inline styles. this dedups
 * identical declaration sets into shared bem-named classes (block + block__element)
 * and emits either a flat css ruleset or a nested scss block. like the other
 * emitters it works on a copy of the clone so all 7 formats stay derivable from
 * one capture. ported (rewritten) from v1 css-to-bem.ts (inline-to-class dedup),
 * dropping the per-case branches.
 */
import type { Captured } from '../types';
import { snapValue } from './snap';
import { atRulesCss, type HtmlOutput } from './html';

/** one generated class and the declarations it carries. */
interface ClassRule {
	className: string;
	decls: Array<[string, string]>;
	isRoot: boolean;
}

/**
 * emits the snip as bem-classed markup plus a css or scss stylesheet.
 *
 * @param captured — read-only; a deep copy of the clone is transformed
 * @param scss — true for nested scss output, false for flat css
 */
export function emitBem(captured: Captured, scss: boolean): HtmlOutput {
	const work = captured.clone.cloneNode(true) as Element;
	const block = sanitize(firstClassOrTag(work)) || 'snip';
	const elements = [work, ...Array.from(work.querySelectorAll('*'))] as HTMLElement[];

	const byDecls = new Map<string, ClassRule>(); // declString -> class (dedup)
	const rules: ClassRule[] = [];
	const tagCounters = new Map<string, number>();

	for (const el of elements) {
		const decls = readDecls(el);
		el.removeAttribute('style');
		if (decls.length === 0) {
			el.removeAttribute('class');
			continue;
		}
		const isRoot = el === work;
		const key = declKey(decls);
		let rule = byDecls.get(key);
		if (!rule) {
			const className = isRoot ? block : uniqueElementClass(block, el.tagName.toLowerCase(), tagCounters);
			rule = { className, decls, isRoot };
			byDecls.set(key, rule);
			rules.push(rule);
		}
		el.setAttribute('class', rule.className);
	}

	const css = (scss ? scssText(block, rules) : cssText(rules)) + atRulesAppendix(captured);
	return { html: work.outerHTML, css };
}

/** read an element's inline declarations, snapping values for cleaner output. */
function readDecls(el: HTMLElement): Array<[string, string]> {
	const out: Array<[string, string]> = [];
	const style = el.style;
	for (let i = 0; i < style.length; i++) {
		const prop = style.item(i);
		if (!prop) continue;
		out.push([prop, snapValue(prop, style.getPropertyValue(prop)).value]);
	}
	return out;
}

/** a stable key over a declaration set so identical sets share one class. */
function declKey(decls: Array<[string, string]>): string {
	return [...decls]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([p, v]) => `${p}:${v}`)
		.join(';');
}

/** a fresh `block__tag-n` class, numbered per tag so names stay readable. */
function uniqueElementClass(block: string, tag: string, counters: Map<string, number>): string {
	const n = (counters.get(tag) ?? 0) + 1;
	counters.set(tag, n);
	return `${block}__${sanitize(tag)}-${n}`;
}

/** flat css: one rule per generated class. */
function cssText(rules: ClassRule[]): string {
	return rules.map((r) => `.${r.className} {\n${declLines(r.decls)}\n}`).join('\n\n');
}

/**
 * nested scss: the block rule with its element rules nested via `&__...`. bem
 * names are flat regardless of dom depth, so every element rule nests one level
 * under the block.
 */
function scssText(block: string, rules: ClassRule[]): string {
	const root = rules.find((r) => r.isRoot);
	const children = rules.filter((r) => !r.isRoot);
	const inner = children
		.map((r) => `\t&__${r.className.slice(block.length + 2)} {\n${declLines(r.decls, 2)}\n\t}`)
		.join('\n');
	const rootDecls = root ? declLines(root.decls, 1) : '';
	return `.${block} {\n${rootDecls}${rootDecls && inner ? '\n' : ''}${inner}\n}`;
}

/** serialize declarations as indented `prop: value;` lines. */
function declLines(decls: Array<[string, string]>, indent = 1): string {
	const pad = '\t'.repeat(indent);
	return decls.map(([p, v]) => `${pad}${p}: ${v};`).join('\n');
}

/** the @font-face/@keyframes block, prefixed with a blank line if present. */
function atRulesAppendix(captured: Captured): string {
	const at = atRulesCss(captured);
	return at ? `\n\n${at}` : '';
}

/** the first author class token on the root, or its tag name, as the block base. */
function firstClassOrTag(el: Element): string {
	const first = Array.from(el.classList)[0];
	return first ?? el.tagName.toLowerCase();
}

/** lowercase, hyphenate, and trim a token for use in a class name. */
function sanitize(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}
