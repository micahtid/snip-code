/**
 * assistive/selectors.ts: assistive element descriptor
 *
 * Pipeline position: capture
 * Reads from Captured: element
 * Writes to Captured: n/a (returns the element descriptor)
 *
 * Principles applied: none.
 *
 * Why this exists: the assistive json's `element` block needs both a shortest-
 * unique `selector` and a churn-resistant `robustSelector`. Those are
 * computed once during capture (capture/dom.ts buildElementMetadata) and stored on
 * Captured.element; this module is the assistive-side accessor for that block, so
 * emit.ts depends on the assistive layer rather than reaching into capture. It
 * also guards that both selectors are populated.
 */
import type { Captured } from '../types';

/**
 * Returns the assistive element descriptor, asserting both selectors are present.
 *
 * @param captured - reads the element metadata built during capture
 */
export function describeElement(captured: Captured): Captured['element'] {
	const el = captured.element;
	// Both selectors are always emitted (definition of done); fall back to the
	// shortest selector if a robust one could not be derived.
	if (!el.robustSelector) el.robustSelector = el.selector;
	return el;
}
