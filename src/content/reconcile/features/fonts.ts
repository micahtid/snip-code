/**
 * features/fonts.ts — variable-font + font-metric properties
 *
 * Phase: g (tier 1 feature handlers) — see SNIPCODE-REWRITE-PLAN.md section 12
 * Pipeline position: 2 — reconcile
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
 * Test bundle: TODO — add in Stage 5 (variable-font specimen).
 *
 * Why this exists: variable-font axis settings and opentype feature settings are
 * frequently applied by a font's own @font-face or a high-level shorthand and do
 * not appear as explicit authored declarations on each element, so P1 never bakes
 * them and they revert to default when the snip is reparented (wrong weight/width,
 * lost ligatures). baking the computed value is pixel-safe: it reproduces exactly
 * what already rendered. the matching @font-face descriptors (size-adjust,
 * ascent/descent/line-gap-override, unicode-range, font-display) travel via
 * resolve/fonts.ts. tier 2 (commit 34) extends this file with text micro-features.
 */
import type { Captured } from '../../types';

/**
 * the font-metric properties this handler preserves — the bounded css-spec
 * surface for variable + opentype font rendering (a feature-handler spec set,
 * not a decision-layer property Set; section 6).
 */
const FONT_METRIC_PROPS = ['font-variation-settings', 'font-feature-settings', 'font-optical-sizing', 'font-stretch'];

/** computed values that mean "default" and need no baking. */
function isDefault(prop: string, value: string): boolean {
	const v = value.trim();
	if (v === '' || v === 'normal' || v === 'auto' || v === 'none') return true;
	// font-stretch resolves to a percentage; 100% is the default.
	if (prop === 'font-stretch' && (v === '100%' || v === 'normal')) return true;
	return false;
}

/**
 * bakes non-default variable-font and font-metric settings onto each element.
 *
 * @param captured — bakedStyles + clone are mutated in place
 */
export function apply(captured: Captured): Captured {
	const originals = subtreeElements(captured.root);
	const clones = subtreeElements(captured.clone);
	if (originals.length !== clones.length) return captured; // structure diverged; skip

	for (let i = 0; i < originals.length; i++) {
		const original = originals[i];
		const clone = clones[i];
		if (!original || !clone) continue;
		const computed = getComputedStyle(original);
		const baked = captured.bakedStyles.get(clone) ?? new Map<string, string>();
		for (const prop of FONT_METRIC_PROPS) {
			if (baked.has(prop)) continue; // already baked by P1 (authored)
			const value = computed.getPropertyValue(prop);
			if (isDefault(prop, value)) continue;
			baked.set(prop, value);
			try {
				(clone as HTMLElement).style.setProperty(prop, value);
			} catch {
				// invalid for this element; skip.
			}
		}
		captured.bakedStyles.set(clone, baked);
	}
	return captured;
}

/** depth-first element list, root first — matches reconcile traversal order. */
function subtreeElements(root: Element): Element[] {
	const out: Element[] = [];
	const walk = (el: Element): void => {
		out.push(el);
		for (const child of Array.from(el.children)) walk(child);
	};
	walk(root);
	return out;
}
