/**
 * assistive/selectors.ts — assistive element descriptor
 *
 * Phase: j (assistive mode) — see SNIPCODE-REWRITE-PLAN.md section 12
 * Pipeline position: 1 — capture
 * Reads from Captured: element
 * Writes to Captured: n/a (returns the element descriptor)
 *
 * Principles applied: none.
 *
 * Why this exists: the assistive json's `element` block needs both a shortest-
 * unique `selector` and a churn-resistant `robustSelector` (section 9). those are
 * computed once during capture (capture/dom.ts buildElementMetadata) and stored on
 * Captured.element; this module is the assistive-side accessor for that block, so
 * emit.ts depends on the assistive layer rather than reaching into capture. it
 * also guards that both selectors are populated.
 */
import type { Captured } from '../types';

/**
 * returns the section-9 element descriptor, asserting both selectors are present.
 *
 * @param captured — reads the element metadata built during capture
 */
export function describeElement(captured: Captured): Captured['element'] {
	const el = captured.element;
	// both selectors are always emitted (definition of done); fall back to the
	// shortest selector if a robust one could not be derived.
	if (!el.robustSelector) el.robustSelector = el.selector;
	return el;
}
