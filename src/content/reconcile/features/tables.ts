/**
 * features/tables.ts: table rendering properties
 *
 * Pipeline position: reconcile
 * Reads from Captured: root, clone (via bakeNonDefaultProps)
 * Writes to Captured: bakedStyles + clone (table layout properties)
 *
 * Extends the "ship what renders" approach to table-only properties.
 *
 * CSS/spec reference: https://developer.mozilla.org/en-US/docs/Web/CSS/border-collapse
 * (also table-layout, border-spacing, caption-side, empty-cells)
 * Detection criterion: a table element whose computed value for one of these
 * properties is non-default. Non-tables compute the defaults and are skipped,
 * so no tag check is needed.
 * Transform contract: bakes the non-default values onto the matching clone
 * element (via the shared reconcile helper). bakedStyles + clone only.
 * Test bundle: TODO, add later (collapsed-border data table).
 *
 * Why this exists: border-collapse, border-spacing, table-layout, and
 * caption-side change a table's geometry but are inherited/table-scoped and
 * frequently set on the <table> by a class that does not survive, so a snipped
 * table loses its collapsed borders or fixed layout. Baking the computed value is
 * pixel-safe.
 */
import type { Captured } from '../../types';
import { bakeNonDefaultProps } from '../match';

/**
 * Bakes non-default table rendering properties onto table elements.
 *
 * @param captured - bakedStyles + clone mutated in place
 */
export function apply(captured: Captured): Captured {
	bakeNonDefaultProps(captured, [
		{ prop: 'table-layout', isDefault: (v) => v === 'auto' },
		{ prop: 'border-collapse', isDefault: (v) => v === 'separate' },
		{ prop: 'border-spacing', isDefault: (v) => v === '0px' || v === '0px 0px' },
		{ prop: 'caption-side', isDefault: (v) => v === 'top' },
		{ prop: 'empty-cells', isDefault: (v) => v === 'show' },
	]);
	return captured;
}
