/**
 * convert/tailwind.ts — inline styles -> tailwind utility classes
 *
 * Phase: e (convert) — see SNIPCODE-REWRITE-PLAN.md section 12
 * Pipeline position: 4 — convert
 * Reads from Captured: clone (inline-styled)
 * Writes to Captured: nothing (deep-copies the clone; canonical clone untouched)
 *
 * Principles applied: none directly; a format transform of the baked result.
 *
 * Why this exists: the tailwind / jsx-tailwind formats (decision 10) express
 * styles as utility classes. this walks a *copy* of the baked clone (so all 7
 * formats stay derivable from one capture, per the definition of done) and turns
 * each element's inline declarations into utilities: a curated map for the common
 * properties (display, flex, spacing, color via the palette matcher), and
 * tailwind's arbitrary-value syntax `[prop:value]` for everything else — which
 * guarantees full coverage and exact fidelity in a tailwind environment without
 * an exhaustive mapping table. ported (rewritten) from v1 css-to-tailwind.ts +
 * tailwind-extractor.ts (conversion mappings + arbitrary-value handling).
 */
import type { Captured } from '../types';
import { snapValue } from './snap';
import { matchColor } from './tw-palette';
import { atRulesCss, type HtmlOutput } from './html';

/**
 * emits the snip as tailwind-classed markup plus the shared @font-face/@keyframes
 * block. fidelity in a tailwind project comes from utilities + arbitrary values;
 * the grader uses the inline html format, so this targets clean, usable output.
 *
 * @param captured — read-only; a deep copy of the clone is transformed
 */
export function emitTailwind(captured: Captured): HtmlOutput {
	const work = captured.clone.cloneNode(true) as Element;
	for (const el of [work, ...Array.from(work.querySelectorAll('*'))]) {
		const classes = elementToClasses(el as HTMLElement);
		el.removeAttribute('style');
		// replace page classes (they carry no css in the output) with utilities.
		if (classes.length > 0) el.setAttribute('class', classes.join(' '));
		else el.removeAttribute('class');
	}
	return { html: work.outerHTML, css: atRulesCss(captured) };
}

/** convert one element's inline declarations to a list of tailwind classes. */
function elementToClasses(el: HTMLElement): string[] {
	const classes: string[] = [];
	const style = el.style;
	for (let i = 0; i < style.length; i++) {
		const prop = style.item(i);
		if (!prop) continue;
		const raw = style.getPropertyValue(prop);
		const value = snapValue(prop, raw).value;
		classes.push(...classesFor(prop, value));
	}
	return classes;
}

/**
 * maps one (property, value) to tailwind class(es). curated utilities for common
 * properties; arbitrary-value fallback for the rest so coverage is total.
 */
function classesFor(prop: string, value: string): string[] {
	// colors go through the palette matcher first.
	if (prop === 'color') return [colorClass('text', value)];
	if (prop === 'background-color') return [colorClass('bg', value)];
	if (prop === 'border-color') return [colorClass('border', value)];

	switch (prop) {
		case 'display':
			return [displayClass(value)];
		case 'flex-direction':
			return [value === 'column' ? 'flex-col' : value === 'row' ? 'flex-row' : arbitrary(prop, value)];
		case 'justify-content':
			return [`justify-${alignToken(value)}`];
		case 'align-items':
			return [`items-${alignToken(value)}`];
		case 'text-align':
			return [`text-${value}`];
		case 'font-weight':
			return [fontWeightClass(value)];
		case 'font-style':
			return [value === 'italic' ? 'italic' : value === 'normal' ? 'not-italic' : arbitrary(prop, value)];
		case 'position':
			return ['static', 'relative', 'absolute', 'fixed', 'sticky'].includes(value)
				? [value]
				: [arbitrary(prop, value)];
		case 'font-size':
			return [`text-[${tok(value)}]`];
		case 'border-radius':
			return [`rounded-[${tok(value)}]`];
		case 'padding':
			return [`p-[${tok(value)}]`];
		case 'padding-top':
			return [`pt-[${tok(value)}]`];
		case 'padding-right':
			return [`pr-[${tok(value)}]`];
		case 'padding-bottom':
			return [`pb-[${tok(value)}]`];
		case 'padding-left':
			return [`pl-[${tok(value)}]`];
		case 'margin':
			return [`m-[${tok(value)}]`];
		case 'margin-top':
			return [`mt-[${tok(value)}]`];
		case 'margin-right':
			return [`mr-[${tok(value)}]`];
		case 'margin-bottom':
			return [`mb-[${tok(value)}]`];
		case 'margin-left':
			return [`ml-[${tok(value)}]`];
		case 'width':
			return [`w-[${tok(value)}]`];
		case 'height':
			return [`h-[${tok(value)}]`];
		case 'gap':
			return [`gap-[${tok(value)}]`];
		default:
			return [arbitrary(prop, value)];
	}
}

/** prefix-{token} when the color matches the palette, else an arbitrary value. */
function colorClass(prefix: 'text' | 'bg' | 'border', value: string): string {
	const match = matchColor(value);
	if (match) return `${prefix}-${match.name}`;
	return `${prefix}-[${tok(value)}]`;
}

/** display keyword -> tailwind utility (`none` becomes `hidden`). */
function displayClass(value: string): string {
	if (value === 'none') return 'hidden';
	if (['flex', 'grid', 'block', 'inline', 'inline-block', 'inline-flex', 'inline-grid', 'contents', 'flow-root'].includes(value)) {
		return value;
	}
	return arbitrary('display', value);
}

/** normalize a flex alignment keyword to tailwind's short token. */
function alignToken(value: string): string {
	return value
		.replace('flex-start', 'start')
		.replace('flex-end', 'end')
		.replace('space-between', 'between')
		.replace('space-around', 'around')
		.replace('space-evenly', 'evenly');
}

/** numeric/keyword font-weight -> tailwind weight utility. */
function fontWeightClass(value: string): string {
	const map: Record<string, string> = {
		'100': 'font-thin', '200': 'font-extralight', '300': 'font-light', '400': 'font-normal',
		'500': 'font-medium', '600': 'font-semibold', '700': 'font-bold', '800': 'font-extrabold', '900': 'font-black',
		normal: 'font-normal', bold: 'font-bold',
	};
	return map[value] ?? arbitrary('font-weight', value);
}

/** tailwind arbitrary class `[prop:value]` with spaces escaped to underscores. */
function arbitrary(prop: string, value: string): string {
	return `[${prop}:${tok(value)}]`;
}

/** escape a value for use inside a tailwind arbitrary bracket (spaces -> underscores). */
function tok(value: string): string {
	return value.trim().replace(/\s+/g, '_');
}
