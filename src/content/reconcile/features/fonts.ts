/**
 * features/fonts.ts: variable-font + font-metric properties
 *
 * Phase: g (tier 1 feature handlers), see SNIPCODE-REWRITE-PLAN.md section 12
 * Pipeline position: 2, reconcile
 * Reads from Captured: root, clone, bakedStyles
 * Writes to Captured: bakedStyles + clone (bakes non-default font settings)
 *
 * Principles applied: extends P1's "ship what renders" to font properties that
 * the authored cascade often omits.
 *
 * CSS/spec reference: https://developer.mozilla.org/en-US/docs/Web/CSS/font-variation-settings
 *   (also font-feature-settings, font-optical-sizing, font-stretch)
 * Detection criterion: an element whose computed value for one of the font-metric
 *   properties is non-default. early-returns per element otherwise.
 * Transform contract: bakes those computed font values onto the matching clone
 *   element. reads getComputedStyle of the live original; mutates bakedStyles +
 *   clone inline styles only.
 * Test bundle: TODO, add in Stage 5 (variable-font specimen).
 *
 * Why this exists: variable-font axis settings and opentype feature settings are
 * frequently applied by a font's own @font-face or a high-level shorthand and do
 * not appear as explicit authored declarations on each element, so P1 never bakes
 * them and they revert to default when the snip is reparented (wrong weight/width,
 * lost ligatures). baking the computed value is pixel-safe: it reproduces exactly
 * what already rendered. the matching @font-face descriptors (size-adjust,
 * ascent/descent/line-gap-override, unicode-range, font-display) travel via
 * resolve/fonts.ts.
 *
 * tier 2 extension (commit 34): the text micro-features below, text-overflow
 * (ellipsis), text-decoration-skip-ink, word-break, overflow-wrap, hyphens,
 * text-wrap, white-space-collapse, change how text wraps and truncates, which
 * shifts line breaks and visible content; baking the non-default values keeps the
 * captured text layout. (writing-mode lives in features/units with the logical
 * properties it governs.)
 */
import type { Captured } from '../../types';
import { bakeNonDefaultProps } from '../match';

/**
 * the font + text properties this handler preserves, the bounded css-spec
 * surface for variable/opentype fonts and text layout (a feature-handler spec
 * set, not a decision-layer property Set; section 6).
 */
const FONT_AND_TEXT_PROPS = [
	// variable + opentype font metrics.
	{ prop: 'font-variation-settings', isDefault: (v: string) => v === 'normal' },
	{ prop: 'font-feature-settings', isDefault: (v: string) => v === 'normal' },
	{ prop: 'font-optical-sizing', isDefault: (v: string) => v === 'auto' || v === 'normal' },
	{ prop: 'font-stretch', isDefault: (v: string) => v === '100%' || v === 'normal' },
	// text micro-features.
	{ prop: 'text-overflow', isDefault: (v: string) => v === 'clip' },
	{ prop: 'text-decoration-skip-ink', isDefault: (v: string) => v === 'auto' },
	{ prop: 'word-break', isDefault: (v: string) => v === 'normal' },
	{ prop: 'overflow-wrap', isDefault: (v: string) => v === 'normal' },
	{ prop: 'hyphens', isDefault: (v: string) => v === 'manual' },
	{ prop: 'text-wrap', isDefault: (v: string) => v === 'wrap' || v === 'auto' },
	{ prop: 'white-space-collapse', isDefault: (v: string) => v === 'collapse' },
];

/**
 * bakes non-default font-metric and text-layout settings onto each element.
 *
 * @param captured - bakedStyles + clone are mutated in place
 */
export function apply(captured: Captured): Captured {
	bakeNonDefaultProps(captured, FONT_AND_TEXT_PROPS);
	return captured;
}
