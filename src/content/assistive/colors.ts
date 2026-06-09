/**
 * assistive/colors.ts — color extraction
 *
 * Phase: j (assistive mode) — see SNIPCODE-REWRITE-PLAN.md section 12
 * Pipeline position: 1 — capture (assistive runs phase 1 only)
 * Reads from Captured: root
 * Writes to Captured: n/a (returns a color list)
 *
 * Principles applied: none (extraction).
 *
 * Why this exists: assistive mode hands a coding agent a palette of the colors a
 * component actually uses, so it can match them. this walks the picked subtree's
 * computed styles and collects the distinct, non-transparent colors across the
 * paint properties, most-used first. ported (rewritten) from v1
 * colors/color-extractor.ts.
 */

const PAINT_PROPS = ['color', 'background-color', 'border-top-color', 'border-bottom-color', 'border-left-color', 'border-right-color', 'fill', 'stroke', 'outline-color'];

/** one extracted color and how many elements use it. */
export interface ColorUse {
	value: string;
	count: number;
}

/**
 * collects the distinct colors used across the subtree, most-used first.
 *
 * @param root — the picked element
 */
export function extractColors(root: Element): ColorUse[] {
	const counts = new Map<string, number>();
	for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
		const computed = getComputedStyle(el);
		for (const prop of PAINT_PROPS) {
			const value = computed.getPropertyValue(prop).trim();
			if (!value || isTransparent(value)) continue;
			counts.set(value, (counts.get(value) ?? 0) + 1);
		}
	}
	return [...counts.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
}

/** true for fully-transparent / absent paint values that carry no palette signal. */
function isTransparent(value: string): boolean {
	return value === 'transparent' || value === 'rgba(0, 0, 0, 0)' || value === 'none' || value === 'currentcolor';
}
