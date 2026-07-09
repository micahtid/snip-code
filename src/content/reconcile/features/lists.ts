/**
 * features/lists.ts: list + counter properties
 *
 * Pipeline position: reconcile
 * Reads from Captured: root and clone, via bakeNonDefaultProps
 * Writes to Captured: bakedStyles + clone, the list + counter properties
 *
 * This extends the "ship what renders" approach to list and counter properties.
 *
 * CSS/spec reference: https://developer.mozilla.org/en-US/docs/Web/CSS/list-style
 * also covers counter-reset and counter-increment, which drive ::marker via features/pseudo.
 * Detection criterion: an element with a non-default list-style-* or counter-*
 * value. Otherwise it early-returns per property.
 * Transform contract: it bakes the non-default values onto the matching clone
 * element. List-style-image urls arrive already absolute from getComputedStyle.
 * It touches bakedStyles and the clone only.
 *
 * Why this exists: custom bullet glyphs (list-style-type), bullet images
 * (list-style-image), and counters (counter-reset and counter-increment) are
 * rendered through ::marker. They are list-scoped and set through classes that do
 * not survive, so a snipped list reverts to plain discs or numbers. Baking the
 * computed value is pixel-safe. features/pseudo emits the ::marker rule that
 * consumes the counters.
 */
import type { Captured } from '../../types';
import { bakeNonDefaultProps } from '../match';

/**
 * Bakes non-default list-style and counter properties.
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
