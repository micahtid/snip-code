/**
 * minimize/logical.ts: fold logical properties to physical
 *
 * Pipeline position: minimize, after prune and before normalize
 * Reads from Captured: page.viewport via the oracle; warnings on graceful skip
 * Writes to Captured: nothing; transforms the stylesheet string
 *
 * Why this exists: the reproduce phase emits whatever the engine computed, which for a
 * left-to-right, horizontal page is a mix of logical properties, margin-inline-start,
 * border-end-end-radius, inset-block, that a human writing that page would have spelled
 * physically: margin-left, border-bottom-right-radius, top/bottom. Left as logical, four
 * corner radii never fold, because border-radius is a physical shorthand. This rewrites the
 * logical properties to their physical equivalents, but only on the rules whose every matched
 * element is horizontal-tb and ltr, where the two are exactly equivalent; the normalize pass
 * that runs next then folds the completed physical sets into border-radius, margin, and the
 * rest. An element that is vertical or rtl keeps its logical properties, which is what a human
 * would write there too.
 *
 * The rewrite is equivalence by the css spec for a horizontal-tb ltr element, so it is
 * render-neutral by construction, but each rule is still checked against the oracle as a
 * backstop and reverted if anything moved.
 */
import type { Captured } from '../types';
import { createRenderOracle, type RenderOracle } from './oracle';
import { inScopeRule, parseSegments } from './declarations';
import { serializeRules } from './declarations';

/** Logical longhands and one-value directionals mapped to their horizontal-tb ltr physical name. */
const LONGHAND: Record<string, string> = {
	'border-start-start-radius': 'border-top-left-radius',
	'border-start-end-radius': 'border-top-right-radius',
	'border-end-start-radius': 'border-bottom-left-radius',
	'border-end-end-radius': 'border-bottom-right-radius',
	'inset-block-start': 'top', 'inset-block-end': 'bottom', 'inset-inline-start': 'left', 'inset-inline-end': 'right',
	'margin-block-start': 'margin-top', 'margin-block-end': 'margin-bottom', 'margin-inline-start': 'margin-left', 'margin-inline-end': 'margin-right',
	'padding-block-start': 'padding-top', 'padding-block-end': 'padding-bottom', 'padding-inline-start': 'padding-left', 'padding-inline-end': 'padding-right',
	'block-size': 'height', 'inline-size': 'width',
	'min-block-size': 'min-height', 'max-block-size': 'max-height', 'min-inline-size': 'min-width', 'max-inline-size': 'max-width',
	'border-block-start': 'border-top', 'border-block-end': 'border-bottom', 'border-inline-start': 'border-left', 'border-inline-end': 'border-right',
	'border-block-start-width': 'border-top-width', 'border-block-start-style': 'border-top-style', 'border-block-start-color': 'border-top-color',
	'border-block-end-width': 'border-bottom-width', 'border-block-end-style': 'border-bottom-style', 'border-block-end-color': 'border-bottom-color',
	'border-inline-start-width': 'border-left-width', 'border-inline-start-style': 'border-left-style', 'border-inline-start-color': 'border-left-color',
	'border-inline-end-width': 'border-right-width', 'border-inline-end-style': 'border-right-style', 'border-inline-end-color': 'border-right-color',
};

/** Two-value logical shorthands: the value's start half maps to the first physical side, the end half to the second. */
const PAIR: Record<string, [string, string]> = {
	'margin-block': ['margin-top', 'margin-bottom'], 'margin-inline': ['margin-left', 'margin-right'],
	'padding-block': ['padding-top', 'padding-bottom'], 'padding-inline': ['padding-left', 'padding-right'],
	'inset-block': ['top', 'bottom'], 'inset-inline': ['left', 'right'],
};

/** Logical border shorthands whose single value applies to both physical sides. */
const BOTH: Record<string, [string, string]> = {
	'border-block': ['border-top', 'border-bottom'], 'border-inline': ['border-left', 'border-right'],
};

/** True when any known logical property occurs, so the oracle mount can be skipped otherwise. */
const HAS_LOGICAL = /(?:^|[;{\s])(?:border-(?:start|end)-(?:start|end)-radius|(?:inset|margin|padding|border)-(?:block|inline)|(?:block|inline|min-block|max-block|min-inline|max-inline)-size)/;

/**
 * Rewrites logical properties to physical on the rules whose every matched element is
 * horizontal-tb and ltr. Graceful by contract: returns the input unchanged on any
 * infrastructure failure, and reverts any rule whose rewrite is not render-neutral.
 * Deterministic: rules and declarations are processed in document order.
 *
 * @param css - the stylesheet after prune
 * @param captured - source of the viewport size; warnings are appended here on skip
 * @param markup - the emitted root markup the stylesheet targets, mounted in the oracle
 * @returns the stylesheet with logical properties folded to physical where safe
 */
export async function foldLogical(css: string, captured: Captured, markup: string): Promise<string> {
	if (!css.trim() || !markup.trim() || !HAS_LOGICAL.test(css)) return css;
	let oracle: RenderOracle;
	try {
		oracle = await createRenderOracle(captured, css, markup);
	} catch (err) {
		captured.warnings.push(`minimize: logical fold skipped (${(err as Error).message})`);
		return css;
	}
	try {
		oracle.captureReference();
		for (const rule of Array.from(oracle.sheet.cssRules)) {
			const styleRule = inScopeRule(rule);
			if (!styleRule || !HAS_LOGICAL.test(styleRule.style.cssText)) continue;
			let elements: Element[];
			try {
				elements = Array.from(oracle.body.querySelectorAll(styleRule.selectorText));
			} catch {
				continue;
			}
			if (elements.length === 0 || !elements.every((el) => isHorizontalLtr(oracle.win, el))) continue;

			const rewritten = rewrite(styleRule.style.cssText);
			if (rewritten === null) continue;
			const saved = styleRule.style.cssText;
			styleRule.style.cssText = rewritten;
			// Render-neutral by construction for a horizontal-tb ltr element; the oracle is a
			// backstop against a value the rewrite mishandled. Scoped to the rule's own subtree.
			if (!oracle.matchesSubset(oracle.subtreeTargets(elements))) styleRule.style.cssText = saved;
		}
		return serializeRules(Array.from(oracle.sheet.cssRules));
	} catch (err) {
		captured.warnings.push(`minimize: logical fold skipped (${(err as Error).message})`);
		return css;
	} finally {
		oracle.dispose();
	}
}

/** Whether an element lays out horizontally, left to right, so logical equals physical. */
function isHorizontalLtr(win: Window, el: Element): boolean {
	const cs = win.getComputedStyle(el);
	return cs.writingMode === 'horizontal-tb' && cs.direction === 'ltr';
}

/**
 * Rewrites a rule's logical declarations to physical, or null when it holds none. Longhands
 * are renamed; a two-value logical shorthand splits across its two physical sides; a border
 * block/inline shorthand copies its value to both. A non-logical declaration passes through.
 */
function rewrite(cssText: string): string | null {
	let changed = false;
	const out: string[] = [];
	for (const seg of parseSegments(cssText)) {
		const prop = seg.prop;
		if (LONGHAND[prop]) {
			out.push(`${LONGHAND[prop]}: ${seg.value}`);
			changed = true;
		} else if (PAIR[prop]) {
			const [start, end] = splitPair(seg.value);
			out.push(`${PAIR[prop]![0]}: ${start}`, `${PAIR[prop]![1]}: ${end}`);
			changed = true;
		} else if (BOTH[prop]) {
			out.push(`${BOTH[prop]![0]}: ${seg.value}`, `${BOTH[prop]![1]}: ${seg.value}`);
			changed = true;
		} else {
			out.push(seg.decl);
		}
	}
	return changed ? out.join('; ') : null;
}

/**
 * Splits a two-value logical value into its start and end halves, carrying any !important to
 * both. One value applies to both sides. Splits on top-level whitespace so a function's inner
 * spaces do not split it.
 */
function splitPair(value: string): [string, string] {
	const bang = /\s*!important\s*$/i.exec(value);
	const important = bang ? ' !important' : '';
	const core = bang ? value.slice(0, bang.index) : value;
	const parts = topLevelParts(core.trim());
	const start = parts[0] ?? '';
	const end = parts[1] ?? start;
	return [`${start}${important}`, `${end}${important}`];
}

/** Splits a value on top-level whitespace, keeping function arguments and their spaces intact. */
function topLevelParts(value: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let buf = '';
	for (const ch of value) {
		if (ch === '(') depth++;
		else if (ch === ')') depth = Math.max(0, depth - 1);
		if (depth === 0 && /\s/.test(ch)) {
			if (buf) { parts.push(buf); buf = ''; }
		} else {
			buf += ch;
		}
	}
	if (buf) parts.push(buf);
	return parts;
}
