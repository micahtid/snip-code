/**
 * inspect/schema/optimize.ts: schema size reduction
 *
 * Pipeline position: inspect, page-scoped. It post-processes the extracted schema.
 * Reads from DOM: nothing. It operates on the extracted schema.
 * Writes to: nothing. It returns an optimized copy.
 *
 * Principles applied: none. This is transformation.
 *
 * Why this exists: the raw schema can be large, and the ai pass pays per token, so
 * this trims it before the prompt: dedupe and cap the color palette, sort and bound
 * spacing, merge near-identical style entries, and apply hard caps on the style
 * map, structure, states, sections, and blueprints. The caps keep the prompt small,
 * a simpler defense against a slow model than any timeout. Ported by rewriting
 * from v1 schema/schema-optimizer.ts.
 */
import type { PageSchema } from './types';

/** Returns a size-reduced copy of the schema, ready to serialize for the prompt. */
export function optimizeSchema(schema: PageSchema): PageSchema {
	const optimized: PageSchema = { ...schema };

	optimized.tokens = {
		...optimized.tokens,
		colors: deduplicateColors(schema.tokens.colors),
		spacing: optimizeSpacing(schema.tokens.spacing),
		radii: [...new Set(schema.tokens.radii)].slice(0, 8),
		shadows: [...new Set(schema.tokens.shadows)].slice(0, 6),
		...(schema.tokens.spacingAnalysis ? { spacingAnalysis: schema.tokens.spacingAnalysis } : {}),
		...(schema.tokens.scaleAnalysis ? { scaleAnalysis: schema.tokens.scaleAnalysis } : {}),
		...(schema.tokens.consistency ? { consistency: schema.tokens.consistency } : {}),
	};

	optimized.styles = mergeNearIdenticalStyles(schema.styles);

	const styleEntries = Object.entries(optimized.styles);
	if (styleEntries.length > 80) optimized.styles = Object.fromEntries(styleEntries.slice(0, 80));
	if (optimized.structure.length > 50) optimized.structure = optimized.structure.slice(0, 50);
	if (optimized.states.length > 30) optimized.states = optimized.states.slice(0, 30);
	if (optimized.sections.length > 15) optimized.sections = optimized.sections.slice(0, 15);
	if (optimized.contentPatterns.length > 8) optimized.contentPatterns = optimized.contentPatterns.slice(0, 8);
	if (optimized.buttons.length > 4) optimized.buttons = optimized.buttons.slice(0, 4);
	if (optimized.cards.length > 3) optimized.cards = optimized.cards.slice(0, 3);

	return optimized;
}

/** Merge colors that normalize to the same hex, summing counts. Keep the top 25. */
function deduplicateColors(colors: PageSchema['tokens']['colors']): PageSchema['tokens']['colors'] {
	const merged = new Map<string, { contexts: Set<string>; count: number }>();
	for (const entry of colors) {
		const normalized = entry.value.toLowerCase();
		const existing = merged.get(normalized);
		if (existing) {
			entry.contexts.forEach((c) => existing.contexts.add(c));
			existing.count += entry.count;
		} else {
			merged.set(normalized, { contexts: new Set(entry.contexts), count: entry.count });
		}
	}
	return Array.from(merged.entries())
		.map(([value, data]) => ({ value, contexts: Array.from(data.contexts), count: data.count }))
		.sort((a, b) => b.count - a.count)
		.slice(0, 25);
}

/** Sort and dedupe spacing values, drop outliers (>200px), keep the smallest 15. */
function optimizeSpacing(spacing: string[]): string[] {
	return [...new Set(spacing)]
		.map((v) => ({ raw: v, px: parseFloat(v) }))
		.filter((v) => !isNaN(v.px) && v.px > 0 && v.px <= 200)
		.sort((a, b) => a.px - b.px)
		.map((v) => v.raw)
		.slice(0, 15);
}

/**
 * When there are many style entries, collapse pairs that differ by one property,
 * dropping the near-duplicate. Only runs above 40 entries. Below that the map is
 * already small enough to leave intact.
 */
function mergeNearIdenticalStyles(styles: Record<string, Record<string, string>>): Record<string, Record<string, string>> {
	const entries = Object.entries(styles);
	if (entries.length <= 40) return styles;

	const result: Record<string, Record<string, string>> = {};
	const merged = new Set<string>();

	for (let i = 0; i < entries.length; i++) {
		const [id1, props1] = entries[i]!;
		if (merged.has(id1)) continue;

		let bestMerge: string | null = null;
		let minDiff = Infinity;
		for (let j = i + 1; j < entries.length; j++) {
			const [id2, props2] = entries[j]!;
			if (merged.has(id2)) continue;
			const diff = styleDistance(props1, props2);
			if (diff <= 1 && diff < minDiff) {
				minDiff = diff;
				bestMerge = id2;
			}
		}

		result[id1] = props1;
		if (bestMerge) merged.add(bestMerge);
	}

	return result;
}

/** Count how many properties differ between two style entries. */
function styleDistance(a: Record<string, string>, b: Record<string, string>): number {
	let diff = 0;
	for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
		if (a[key] !== b[key]) diff++;
	}
	return diff;
}
