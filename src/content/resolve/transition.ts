/**
 * resolve/transition.ts: lossless transition-shorthand timing
 *
 * Pipeline position: resolve, after var resolution
 * Reads from Captured: clone, bakedStyles
 * Writes to Captured: bakedStyles + clone (a spec-equivalent rewrite of one property family)
 *
 * Why this exists: a common Tailwind pattern sets a multi-entry `transition-property` list,
 * `color, background-color, border-color, ...`, against a `transition-duration` and
 * `transition-timing-function` authored as a single-value `var()`, which css cycles across
 * every property. resolve/vars.ts resolves that `var()` to its one literal (`0.15s`), leaving
 * a single-entry timing sub-list against the many-entry property list. When the clone's inline
 * style then serializes, the cssom folds the transition longhands into the `transition`
 * shorthand and, with mismatched list lengths, writes the timing onto the first layer only:
 * `color 0.15s cubic-bezier(...), background-color, border-color, ...`. Re-parsed in the
 * emitted stylesheet, every bare layer takes the initial duration `0s`, so on hover the color
 * eases while the background, border, and fill snap, a choppy half-animated flash.
 *
 * This runs after resolution and expands each shorter timing sub-list back to the
 * `transition-property` length by css cycling, exactly the rule the engine already applies, so
 * the later serialization folds losslessly to
 * `color 0.15s cubic-bezier(...), background-color 0.15s cubic-bezier(...), ...` and every
 * property animates over the timing the original declared. It only redistributes timing the
 * author already wrote, never adding motion to a property the original left static, and a
 * single-property list or `transition-property: all` needs no expansion and is left untouched.
 * Render-neutral by construction: cycling is the engine's own rule, so the computed transition
 * is unchanged, and it applies to the canonical clone so every output format ships the fix.
 */
import type { Captured } from '../types';

/** The sub-lists css cycles across the property list; padded to its length before folding. */
export const TIMING_LONGHANDS = ['transition-duration', 'transition-timing-function', 'transition-delay', 'transition-behavior'] as const;

/**
 * Pads every clone element's transition timing sub-lists to its `transition-property` length by
 * css cycling, so the later fold into the `transition` shorthand keeps each layer's timing
 * rather than dropping it onto the first. Mutates the clone inline styles and their baked maps
 * in place. It is a no-op for any element without a genuine multi-property transition whose
 * timing sub-list is shorter than its property list.
 *
 * @param captured - clone + bakedStyles are mutated in place
 */
export function resolveTransitionTiming(captured: Captured): void {
	for (const el of [captured.clone, ...Array.from(captured.clone.querySelectorAll('*'))]) {
		const style = (el as HTMLElement).style;
		if (!style) continue;
		const properties = splitTopLevelCommas(style.getPropertyValue('transition-property'));
		// `all`, `none`, or a single property is one layer, which the cssom never folds lossily.
		if (properties.length < 2) continue;
		const baked = captured.bakedStyles.get(el);
		for (const longhand of TIMING_LONGHANDS) {
			const raw = style.getPropertyValue(longhand);
			if (!raw.trim()) continue; // Longhand absent in this engine, e.g. transition-behavior, so leave it.
			const values = splitTopLevelCommas(raw);
			if (values.length === 0 || values.length >= properties.length) continue; // Already full length.
			const cycled = properties.map((_, i) => values[i % values.length]).join(', ');
			try {
				style.setProperty(longhand, cycled, style.getPropertyPriority(longhand));
			} catch {
				// Invalid for this element, so skip it rather than throw.
			}
			baked?.set(longhand, cycled); // Keep the baked map in step with the inline style.
		}
	}
}

/**
 * Splits a comma-separated value list on top-level commas only, so a comma inside a function
 * such as `cubic-bezier(0.4, 0, 0.2, 1)` or `steps(4, end)` stays within its layer. Empty
 * entries are dropped, matching how the engine reads a transition sub-list.
 *
 * @param value - a transition sub-list value, possibly carrying nested function commas
 */
export function splitTopLevelCommas(value: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let buf = '';
	for (const ch of value) {
		if (ch === '(') depth++;
		else if (ch === ')') depth = Math.max(0, depth - 1);
		if (ch === ',' && depth === 0) {
			if (buf.trim()) parts.push(buf.trim());
			buf = '';
		} else {
			buf += ch;
		}
	}
	if (buf.trim()) parts.push(buf.trim());
	return parts;
}
