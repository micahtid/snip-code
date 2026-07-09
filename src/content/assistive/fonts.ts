/**
 * assistive/fonts.ts: assistive font extraction.
 *
 * Pipeline position: capture. Assistive runs the capture phase only.
 * Reads from Captured: root.
 * It does not write to Captured. It returns a font list.
 *
 * No principles apply here, since this is extraction.
 *
 * Why this exists: assistive mode reports the font families a component renders with so an
 * agent can load or substitute them. This reuses the same "first non-generic family per
 * element" idea as resolve/fonts.ts, but it reads it straight from the live subtree's computed
 * styles. Assistive runs only the capture phase, so there are no baked styles yet. Generic
 * keywords are skipped without a keyword Set because the first family token is what renders.
 */

/**
 * Collects the distinct font-family stacks used across the subtree, most-used first.
 *
 * @param root - the picked element
 */
export function extractFonts(root: Element): string[] {
	const counts = new Map<string, number>();
	for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
		const family = getComputedStyle(el).fontFamily.trim();
		if (!family) continue;
		// The first listed family is the one that actually renders.
		const first = family.split(',')[0]?.replace(/^["']|["']$/g, '').trim() ?? '';
		if (first) counts.set(first, (counts.get(first) ?? 0) + 1);
	}
	return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([family]) => family);
}
