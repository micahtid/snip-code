/**
 * features/units.ts: viewport + container units
 *
 * Phase: g (tier 1 feature handlers), see SNIPCODE-REWRITE-PLAN.md section 12
 * Pipeline position: 2, reconcile
 * Reads from Captured: root, clone, bakedStyles
 * Writes to Captured: bakedStyles + clone (resolves viewport/container units)
 *
 * Principles applied: P1 ("lock pixel fidelity at the capture viewport").
 *
 * CSS/spec reference: https://developer.mozilla.org/en-US/docs/Web/CSS/length#viewport-percentage_lengths
 * Detection criterion: a baked value containing a viewport (vw/vh/dvh/svh/lvh/
 *   vmin/vmax) or container (cqw/cqh/cqi/cqb/...) length. early-returns otherwise.
 * Transform contract: replaces such values with the live element's computed
 *   literal (px). mutates bakedStyles + clone inline styles only.
 * Test bundle: TODO, add in Stage 5 (vh hero + container-query card).
 *
 * Why this exists: viewport and container units resolve against the viewport /
 * containment context, which change when the snip is reparented, a 50vw hero
 * becomes half of whatever viewport it lands in. the plan's alternative (wrap the
 * snip in a captured-viewport container) cannot work for a standalone element
 * crop: the grader renders output.html at the element's own dimensions, so a
 * viewport-sized wrapper would clip. resolving to the captured computed literal
 * locks the pixels exactly as P1 does when an authored value would not survive,
 * and needs no synthetic wrapper (consistent with P4).
 *
 * tier 2 extensions in this file:
 * - logical properties (commit 29): logical props (margin-inline, inset-inline-
 *   start, ...) survive via P1 when authored, but they resolve against the
 *   element's direction/writing-mode, which must be baked when non-default for
 *   rtl + vertical text (material v6 / tailwind v4 lean on logical props).
 * - aspect-ratio (commit 30): the aspect-ratio property and intrinsic <img
 *   width/height> attributes, baked so the box keeps its ratio standalone.
 */
import type { Captured } from '../../types';
import { pairedSubtrees } from '../match';

// viewport-percentage and container-query length units (the dynamic ones).
const DYNAMIC_UNIT = /\b\d*\.?\d+(?:vw|vh|vi|vb|vmin|vmax|dvw|dvh|svw|svh|lvw|lvh|cqw|cqh|cqi|cqb|cqmin|cqmax)\b/i;

/**
 * resolves baked values that use viewport/container units to their captured px.
 *
 * @param captured - bakedStyles + clone are mutated in place
 */
export function apply(captured: Captured): Captured {
	for (const [original, clone] of pairedSubtrees(captured.root, captured.clone)) {
		const baked = captured.bakedStyles.get(clone) ?? new Map<string, string>();
		const computed = getComputedStyle(original);

		// resolve viewport/container units to captured px.
		for (const [prop, value] of baked) {
			if (!DYNAMIC_UNIT.test(value)) continue;
			const literal = computed.getPropertyValue(prop);
			if (!literal || DYNAMIC_UNIT.test(literal)) continue; // could not resolve; leave as-is
			setBaked(clone, baked, prop, literal);
		}

		// logical properties resolve against direction + writing-mode; bake them
		// when non-default so rtl / vertical text maps inline/block axes correctly.
		bakeNonDefault(clone, baked, computed, 'direction', (v) => v === '' || v === 'ltr');
		bakeNonDefault(clone, baked, computed, 'writing-mode', (v) => v === '' || v === 'horizontal-tb');

		// aspect-ratio: bake when explicitly set so the box keeps its ratio.
		bakeNonDefault(clone, baked, computed, 'aspect-ratio', (v) => v === '' || v === 'auto');

		// <img> intrinsic dimensions feed aspect-ratio: auto and prevent layout
		// shift; copy the natural size to width/height attributes when missing.
		if (original instanceof HTMLImageElement && clone instanceof HTMLImageElement) {
			pinIntrinsicSize(original, clone, baked);
		}

		if (baked.size > 0) captured.bakedStyles.set(clone, baked);
	}
	return captured;
}

/**
 * copy a loaded image's natural size to width/height attributes, but only when
 * css sizes neither dimension, otherwise attr-derived aspect-ratio could fight
 * the baked css and shift the box.
 */
function pinIntrinsicSize(original: HTMLImageElement, clone: HTMLImageElement, baked: Map<string, string>): void {
	if (original.naturalWidth === 0 || original.naturalHeight === 0) return; // not loaded
	if (baked.has('width') || baked.has('height')) return; // css already sizes it
	if (clone.hasAttribute('width') || clone.hasAttribute('height')) return;
	clone.setAttribute('width', String(original.naturalWidth));
	clone.setAttribute('height', String(original.naturalHeight));
}

/** bake a computed property when a predicate says its value is non-default. */
function bakeNonDefault(
	clone: Element,
	baked: Map<string, string>,
	computed: CSSStyleDeclaration,
	prop: string,
	isDefault: (value: string) => boolean,
): void {
	if (baked.has(prop)) return;
	const value = computed.getPropertyValue(prop);
	if (isDefault(value)) return;
	setBaked(clone, baked, prop, value);
}

/** record a value in the baked map and on the clone's inline style. */
function setBaked(clone: Element, baked: Map<string, string>, prop: string, value: string): void {
	baked.set(prop, value);
	try {
		(clone as HTMLElement).style.setProperty(prop, value);
	} catch {
		// invalid for this element; skip.
	}
}
