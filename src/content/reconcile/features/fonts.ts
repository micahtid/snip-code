/**
 * features/fonts.ts: variable-font + font-metric properties
 *
 * Pipeline position: reconcile
 * Reads from Captured: root, clone, bakedStyles
 * Writes to Captured: bakedStyles + clone, baking non-default font settings
 *
 * Principles applied: this extends the "ship what renders" rule to the font
 * properties the authored cascade often omits.
 *
 * CSS/spec reference: https://developer.mozilla.org/en-US/docs/Web/CSS/font-variation-settings
 * also covers font-feature-settings, font-optical-sizing, font-stretch.
 * Detection criterion: an element whose computed value for one of the font-metric
 * properties is non-default. Otherwise it early-returns per element.
 * Transform contract: it bakes those computed font values onto the matching clone
 * element. It reads getComputedStyle of the live original and mutates bakedStyles
 * and the clone inline styles only.
 *
 * Why this exists: variable-font axis settings and opentype feature settings are
 * frequently applied by a font's own @font-face or a high-level shorthand, and they
 * do not appear as explicit authored declarations on each element. So the
 * per-element pass never bakes them, and they revert to default when the snip is
 * reparented, giving the wrong weight or width and lost ligatures. Baking the
 * computed value is pixel-safe, because it reproduces exactly what already rendered.
 * The matching @font-face descriptors (size-adjust, ascent/descent/line-gap-override,
 * unicode-range, font-display) travel via resolve/fonts.ts.
 *
 * The text micro-features below (text-overflow with ellipsis,
 * text-decoration-skip-ink, word-break, overflow-wrap, hyphens, text-wrap, and
 * white-space-collapse) change how text wraps and truncates, which shifts line
 * breaks and visible content. Baking the non-default values keeps the captured text
 * layout. Writing-mode lives in features/units with the logical properties it
 * governs.
 */
import type { Captured } from '../../types';
import { bakeNonDefaultProps } from '../match';

/**
 * The font and text properties this handler preserves. This is the bounded css-spec
 * surface for variable and opentype fonts and text layout, a feature-handler spec
 * set rather than a hardcoded property list.
 */
const FONT_AND_TEXT_PROPS = [
	// Variable + opentype font metrics.
	{ prop: 'font-variation-settings', isDefault: (v: string) => v === 'normal' },
	{ prop: 'font-feature-settings', isDefault: (v: string) => v === 'normal' },
	{ prop: 'font-optical-sizing', isDefault: (v: string) => v === 'auto' || v === 'normal' },
	{ prop: 'font-stretch', isDefault: (v: string) => v === '100%' || v === 'normal' },
	// Text micro-features.
	{ prop: 'text-overflow', isDefault: (v: string) => v === 'clip' },
	{ prop: 'text-decoration-skip-ink', isDefault: (v: string) => v === 'auto' },
	{ prop: 'word-break', isDefault: (v: string) => v === 'normal' },
	{ prop: 'overflow-wrap', isDefault: (v: string) => v === 'normal' },
	{ prop: 'hyphens', isDefault: (v: string) => v === 'manual' },
	{ prop: 'text-wrap', isDefault: (v: string) => v === 'wrap' || v === 'auto' },
	{ prop: 'white-space-collapse', isDefault: (v: string) => v === 'collapse' },
];

/**
 * Bakes non-default font-metric and text-layout settings onto each element.
 *
 * @param captured - bakedStyles + clone are mutated in place
 */
export function apply(captured: Captured): Captured {
	bakeNonDefaultProps(captured, FONT_AND_TEXT_PROPS);
	return captured;
}
