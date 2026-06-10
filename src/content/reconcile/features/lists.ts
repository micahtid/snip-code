/**
 * features/lists.ts: list + counter properties
 *
 * Phase: h (tier 2 feature handlers), see SNIPCODE-REWRITE-PLAN.md section 12
 * Pipeline position: 2, reconcile
 * Reads from Captured: root, clone (via bakeNonDefaultProps)
 * Writes to Captured: bakedStyles + clone (list + counter properties)
 *
 * Principles applied: extends P1's "ship what renders" to list/counter properties.
 *
 * CSS/spec reference: https://developer.mozilla.org/en-US/docs/Web/CSS/list-style
 *   (also counter-reset, counter-increment, which drive ::marker via features/pseudo)
 * Detection criterion: an element with a non-default list-style-* or counter-*
 *   value. early-returns per property otherwise.
 * Transform contract: bakes the non-default values onto the matching clone
 *   element. list-style-image urls arrive already-absolute from getComputedStyle.
 *   bakedStyles + clone only.
 * Test bundle: TODO, add in Stage 5 (custom counter list).
 *
 * Why this exists: custom bullet glyphs (list-style-type), bullet images
 * (list-style-image), and counters (counter-reset/increment, rendered through
 * ::marker) are list-scoped and set via classes that do not survive, so a snipped
 * list reverts to plain discs/numbers. baking the computed value is pixel-safe;
 * features/pseudo emits the ::marker rule that consumes the counters.
 */
import type { Captured } from '../../types';
import { bakeNonDefaultProps } from '../match';

/**
 * bakes non-default list-style and counter properties.
 *
 * @param captured - bakedStyles + clone mutated in place
 */
export function apply(captured: Captured): Captured {
	bakeNonDefaultProps(captured, [
		{ prop: 'list-style-type', isDefault: (v) => v === 'disc' || v === 'decimal' || v === 'none' },
		{ prop: 'list-style-image', isDefault: (v) => v === 'none' },
		{ prop: 'list-style-position', isDefault: (v) => v === 'outside' },
		{ prop: 'counter-reset', isDefault: (v) => v === 'none' },
		{ prop: 'counter-increment', isDefault: (v) => v === 'none' },
	]);
	return captured;
}
