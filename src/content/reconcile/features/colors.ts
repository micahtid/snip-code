/**
 * features/colors.ts — modern color preservation + currentColor consolidation
 *
 * Phase: g (tier 1 feature handlers) — see SNIPCODE-REWRITE-PLAN.md section 12
 * Pipeline position: 2 — reconcile
 * Reads from Captured: root, clone, bakedStyles
 * Writes to Captured: bakedStyles + clone (consolidates currentColor)
 *
 * Principles applied: P1 (authored color syntax is preserved when it round-trips;
 * this handler only rewrites a literal back to the equivalent currentColor).
 *
 * CSS/spec reference: https://developer.mozilla.org/en-US/docs/Web/CSS/color_value#currentcolor_keyword
 * Detection criterion: an svg fill/stroke whose baked literal equals the
 *   element's resolved `color`. early-returns per element otherwise.
 * Transform contract: rewrites such literals to the `currentColor` keyword.
 *   mutates bakedStyles + clone inline styles only.
 * Test bundle: TODO — add in Stage 5 (oklch palette + currentColor icons).
 *
 * Why this exists: oklch/oklab/color()/color-mix() already survive serialization
 * because P1 keeps the authored value when it round-trips and otherwise ships the
 * computed value (which chrome serializes in the same color space) — so this
 * handler does not need to touch them. what it does fix is currentColor: chrome's
 * getComputedStyle resolves currentColor on fill/stroke/border to the literal,
 * severing the link to `color`, so an icon that should recolor with its text no
 * longer does. restoring currentColor where the literal matches `color` is
 * pixel-identical and keeps that link (it also matters once polish adds hover
 * rules). this consolidates the currentColor handling v1 spread across 3 places.
 */
import type { Captured } from '../../types';
import { pairedSubtrees } from '../match';

/**
 * svg paint properties that default to currentColor — the bounded css-spec
 * surface for the icon-recolor mechanism (a feature-handler spec set, not a
 * decision-layer property Set; section 6). border/outline color literals are
 * deliberately left alone: rewriting them to currentColor risks serialization
 * drift for no rendering gain (the icon case is what matters).
 */
const COLOR_PROPS = ['fill', 'stroke'];

/**
 * restores currentColor where a color-ish property's literal equals `color`.
 *
 * @param captured — bakedStyles + clone are mutated in place
 */
export function apply(captured: Captured): Captured {
	for (const [original, clone] of pairedSubtrees(captured.root, captured.clone)) {
		const baked = captured.bakedStyles.get(clone);
		if (!baked) continue;
		const colorLiteral = getComputedStyle(original).getPropertyValue('color');
		if (!colorLiteral) continue;
		for (const prop of COLOR_PROPS) {
			const value = baked.get(prop);
			// only collapse an exact literal match; never touch authored color
			// functions (oklch/color-mix) — P1 already preserved those.
			if (value && value === colorLiteral) {
				baked.set(prop, 'currentColor');
				try {
					(clone as HTMLElement).style.setProperty(prop, 'currentColor');
				} catch {
					// invalid for this element; skip.
				}
			}
		}
	}
	return captured;
}
