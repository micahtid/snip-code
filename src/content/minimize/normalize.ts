/**
 * minimize/normalize.ts: shorthand folding + human property order
 *
 * Pipeline position: minimize, after prune and before hoist
 * Reads from Captured: page.viewport via the oracle; warnings on graceful skip
 * Writes to Captured: nothing; transforms the minimized stylesheet string
 *
 * Why this exists: the pruned stylesheet still reads like a machine dump. Each rule lists
 * the longhands the reproduce phase baked, in computed-style order, so a box's four
 * margins sit apart from its four paddings and a border is spelled out as twelve
 * declarations. A human writes the shorthand and groups related properties. This phase
 * does both, in one move: it reorders each rule's declarations into a fixed human order,
 * layout then box then spacing then border then background then type then effects, and
 * lets the cssom fold the now-adjacent longhand families back into their shorthands as it
 * reserializes. margin-top/right/bottom/left becomes margin, the border longhands become
 * border-width/style/color, top/right/bottom/left becomes inset.
 *
 * It is render-neutral by construction and verified anyway. Reordering distinct properties
 * cannot change the cascade, and folding a full longhand family into its shorthand sets the
 * identical values, so the render is unchanged; the computed-style oracle confirms it over
 * the whole stylesheet, and if some rule's reorder did change the render, because it mixed
 * a shorthand with a longhand it overrides, the phase ships the pruned css untouched rather
 * than a wrong render. The transform is a pure string reshuffle, so it is deterministic and
 * never grows the stylesheet.
 *
 * State, pseudo, and at rules are out of scope, exactly as in prune; see inScopeRule.
 */
import type { Captured } from '../types';
import { createRenderOracle } from './oracle';
import { parseSegments, inScopeRule, serializeRules } from './declarations';

/**
 * Property groups in the order a human writes them, each entry a property-name prefix. A
 * declaration's rank is the index of the first prefix its property starts with, and
 * unmatched properties sort to the end, so the order is a soft grouping rather than a
 * strict per-property table. More specific prefixes precede the general one they extend,
 * so border-radius groups ahead of the border line and does not fall into it. Same-rank
 * declarations keep their original relative order, which keeps a shorthand and any longhand
 * it overrides adjacent and in sequence, so folding stays render-safe.
 */
const PROPERTY_ORDER = [
	'position', 'inset', 'top', 'right', 'bottom', 'left', 'z-index',
	'display', 'flex', 'grid', 'gap', 'row-gap', 'column-gap', 'align', 'justify', 'place', 'order',
	'box-sizing', 'aspect-ratio', 'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
	'inline-size', 'block-size', 'min-inline-size', 'min-block-size', 'max-inline-size', 'max-block-size',
	'overflow', 'float', 'clear', 'visibility',
	'margin', 'padding',
	'border-radius', 'border', 'outline',
	'background',
	'color', 'font', 'line-height', 'letter-spacing', 'word-spacing', 'text', 'white-space', 'tab-size',
	'direction', 'writing-mode', 'list-style', 'vertical-align',
	'box-shadow', 'opacity', 'filter', 'backdrop-filter', 'mix-blend-mode',
	'transform', 'transition', 'animation', 'cursor', 'pointer-events', 'user-select', 'will-change',
	'appearance', 'content',
];

/** The human-order rank of a property, or the end for a property no prefix matches. */
function rank(prop: string): number {
	for (let i = 0; i < PROPERTY_ORDER.length; i++) {
		if (prop.startsWith(PROPERTY_ORDER[i]!)) return i;
	}
	return PROPERTY_ORDER.length;
}

/**
 * Normalizes a pruned stylesheet: folds longhand families to shorthands and orders each
 * rule's declarations like a human would. Graceful by contract, returning the input
 * unchanged on any infrastructure failure or if the reorder is not render-neutral.
 *
 * @param css - the pruned stylesheet, after prune
 * @param captured - source of the viewport size; warnings are appended here on skip
 * @param markup - the emitted root markup the stylesheet targets, mounted in the oracle
 * @returns the normalized stylesheet, or the input unchanged on any failure
 */
export async function normalizeCss(css: string, captured: Captured, markup: string): Promise<string> {
	if (!css.trim() || !markup.trim()) return css;
	let oracle;
	try {
		oracle = await createRenderOracle(captured, css, markup);
	} catch (err) {
		captured.warnings.push(`normalize: skipped (${(err as Error).message})`);
		return css;
	}
	try {
		oracle.captureReference();
		const topRules = Array.from(oracle.sheet.cssRules);
		for (const rule of topRules) {
			const styleRule = inScopeRule(rule);
			if (styleRule) reorderRule(styleRule);
		}
		if (oracle.matchesReference()) return serializeRules(topRules);
		// Some rule's reorder changed the render, from a shorthand mixed with a longhand it
		// overrides. Rather than diagnose which, ship the pruned css untouched.
		captured.warnings.push('normalize: reorder not render-neutral; shipped unnormalized');
		return css;
	} catch (err) {
		captured.warnings.push(`normalize: skipped (${(err as Error).message})`);
		return css;
	} finally {
		oracle.dispose();
	}
}

/**
 * Reorders one rule's declarations into the human order in place. Setting the sorted
 * declarations back as one cssText string lets the cssom fold the now-adjacent longhand
 * families into their shorthands as it reserializes, and the cssom preserves the order of
 * distinct properties, so the emitted rule keeps the human grouping.
 *
 * @param styleRule - an in-scope style rule, reordered in place
 */
function reorderRule(styleRule: CSSStyleRule): void {
	const segs = parseSegments(styleRule.style.cssText);
	if (segs.length < 2) return;
	const sorted = segs.slice().sort((a, b) => rank(a.prop) - rank(b.prop));
	styleRule.style.cssText = sorted.map((s) => s.decl).join('; ');
}
