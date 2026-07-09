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
 * The reorder runs on in-scope rules only, exactly as in prune; see inScopeRule. After it, a
 * second pass drops each longhand a preceding shorthand in the same block already sets to that
 * value, the restatement a machine dump leaves behind, most often a border-radius spelled out
 * again as its four corner longhands. That drop is render-neutral by CSS definition, so it
 * needs no oracle and runs on withheld state and pseudo rules too, where such restatement is
 * densest.
 */
import type { Captured } from '../types';
import { withOracle } from './oracle';
import { parseSegments, inScopeRule, serializeRules } from './declarations';
import { LOGICAL_TO_PHYSICAL } from './logical';

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
	return withOracle(css, captured, markup, 'normalize: skipped', (oracle) => {
		oracle.captureReference();
		const topRules = Array.from(oracle.sheet.cssRules);
		for (const rule of topRules) {
			const styleRule = inScopeRule(rule);
			if (styleRule) reorderRule(styleRule);
		}
		if (!oracle.matchesReference()) {
			// Some rule's reorder changed the render, from a shorthand mixed with a longhand it
			// overrides. Rather than diagnose which, ship the pruned css untouched.
			captured.warnings.push('normalize: reorder not render-neutral; shipped unnormalized');
			return css;
		}
		// Drop each longhand a preceding shorthand already covers, in every style rule including
		// the withheld ones. Render-neutral by CSS definition, so it needs no oracle re-check.
		const scratch = oracle.win.document.createElement('span').style;
		for (const rule of topRules) {
			if (rule.type === CSSRule.STYLE_RULE) dropCoveredLonghands(rule as CSSStyleRule, scratch);
		}
		return serializeRules(topRules);
	});
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

/** One physical longhand the cssom stored for a declaration, with its normalized value. */
interface Longhand {
	name: string;
	value: string;
	priority: string;
}

/**
 * Drops each longhand a preceding shorthand in the same block already sets to that exact value,
 * so `border-radius: 4px` followed by its four corner longhands at `4px` keeps only the
 * shorthand. Render-neutral by CSS definition: the shorthand assigns the longhand that value
 * regardless, so removing the restatement cannot change the cascade.
 *
 * A physical longhand is dropped whenever the covering shorthand implies its value, since a
 * physical side is writing-mode independent. A logical longhand, `border-start-start-radius`
 * and the like, is dropped only when the covering shorthand is uniform, one value on every
 * side, because only then is which physical side the logical name resolves to irrelevant and
 * the drop writing-mode independent. Keeping a longhand that sets a different value clears the
 * cover, so a restatement after such an override is not dropped.
 *
 * @param styleRule - a style rule, in-scope or withheld, pruned in place
 * @param scratch - a detached style declaration used to expand a shorthand to its longhands
 */
function dropCoveredLonghands(styleRule: CSSStyleRule, scratch: CSSStyleDeclaration): void {
	const segs = parseSegments(styleRule.style.cssText);
	if (segs.length < 2) return;
	const covered = new Map<string, { value: string; priority: string; uniform: boolean }>();
	const kept: string[] = [];
	for (const seg of segs) {
		const items = expandDeclaration(scratch, seg.decl);
		const isShorthand = items.length > 1 || (items.length === 1 && items[0]!.name !== seg.prop);
		if (isShorthand) {
			kept.push(seg.decl);
			const uniform = items.every((it) => it.value === items[0]!.value && it.priority === items[0]!.priority);
			for (const it of items) covered.set(it.name, { value: it.value, priority: it.priority, uniform });
			continue;
		}
		const self = items[0];
		const physical = LOGICAL_TO_PHYSICAL[seg.prop] ?? seg.prop;
		const cover = covered.get(physical);
		const isLogical = physical !== seg.prop;
		if (self && cover && cover.value === self.value && cover.priority === self.priority && (!isLogical || cover.uniform)) {
			continue; // Redundant restatement of what the shorthand already sets.
		}
		kept.push(seg.decl);
		covered.delete(physical); // This longhand now governs the side; a later shorthand may re-cover it.
	}
	if (kept.length !== segs.length) styleRule.style.cssText = kept.join('; ');
}

/**
 * Expands one declaration to the physical longhands the cssom stores for it, each with its
 * normalized value and priority. A shorthand yields several longhands, `border-radius` its four
 * corners; a plain longhand yields itself. An empty array for a declaration the cssom rejects.
 */
function expandDeclaration(scratch: CSSStyleDeclaration, decl: string): Longhand[] {
	scratch.cssText = '';
	scratch.cssText = decl;
	const items: Longhand[] = [];
	for (let i = 0; i < scratch.length; i++) {
		const name = scratch.item(i);
		items.push({ name, value: scratch.getPropertyValue(name), priority: scratch.getPropertyPriority(name) });
	}
	return items;
}
