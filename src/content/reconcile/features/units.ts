/**
 * features/units.ts — viewport + container units
 *
 * Phase: g (tier 1 feature handlers) — see SNIPCODE-REWRITE-PLAN.md section 12
 * Pipeline position: 2 — reconcile
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
 * Test bundle: TODO — add in Stage 5 (vh hero + container-query card).
 *
 * Why this exists: viewport and container units resolve against the viewport /
 * containment context, which change when the snip is reparented — a 50vw hero
 * becomes half of whatever viewport it lands in. the plan's alternative (wrap the
 * snip in a captured-viewport container) cannot work for a standalone element
 * crop: the grader renders output.html at the element's own dimensions, so a
 * viewport-sized wrapper would clip. resolving to the captured computed literal
 * locks the pixels exactly as P1 does when an authored value would not survive,
 * and needs no synthetic wrapper (consistent with P4). tier 2 (commits 29-30)
 * extends this file with logical properties and aspect-ratio.
 */
import type { Captured } from '../../types';
import { pairedSubtrees } from '../match';

// viewport-percentage and container-query length units (the dynamic ones).
const DYNAMIC_UNIT = /\b\d*\.?\d+(?:vw|vh|vi|vb|vmin|vmax|dvw|dvh|svw|svh|lvw|lvh|cqw|cqh|cqi|cqb|cqmin|cqmax)\b/i;

/**
 * resolves baked values that use viewport/container units to their captured px.
 *
 * @param captured — bakedStyles + clone are mutated in place
 */
export function apply(captured: Captured): Captured {
	for (const [original, clone] of pairedSubtrees(captured.root, captured.clone)) {
		const baked = captured.bakedStyles.get(clone);
		if (!baked) continue;
		let computed: CSSStyleDeclaration | null = null;
		for (const [prop, value] of baked) {
			if (!DYNAMIC_UNIT.test(value)) continue;
			computed ??= getComputedStyle(original);
			const literal = computed.getPropertyValue(prop);
			if (!literal || DYNAMIC_UNIT.test(literal)) continue; // could not resolve; leave as-is
			baked.set(prop, literal);
			try {
				(clone as HTMLElement).style.setProperty(prop, literal);
			} catch {
				// invalid for this element; skip.
			}
		}
	}
	return captured;
}
