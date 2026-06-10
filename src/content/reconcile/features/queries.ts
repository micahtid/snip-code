/**
 * features/queries.ts: @media + @container resolution
 *
 * Phase: g (tier 1 feature handlers), see SNIPCODE-REWRITE-PLAN.md section 12
 * Pipeline position: 2, reconcile
 * Reads from Captured: root, clone, bakedStyles
 * Writes to Captured: bakedStyles + clone (bakes container context)
 *
 * Principles applied: extends P1 to the containment context that container
 * queries resolve against.
 *
 * CSS/spec reference: https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_containment/Container_queries
 * Detection criterion: an element whose computed container-type is not `normal`.
 *   early-returns per element otherwise.
 * Transform contract: bakes container-type (and container-name) onto the matching
 *   clone element. mutates bakedStyles + clone inline styles only.
 * Test bundle: TODO, add in Stage 5 (container-query layout).
 *
 * Why this exists: @media is already flattened at capture, match.ts only admits
 * rules whose @media currently applies (matchMedia), so prefers-color-scheme,
 * prefers-reduced-motion, and breakpoint variants are resolved to the captured
 * viewport's values and baked by P1. @container is the part that needs help: a
 * descendant's container query resolves against an ancestor's containment
 * context, which is lost if container-type is not preserved. baking the computed
 * container-type keeps that context inside the snip; the container's width is
 * locked by features/units.ts (commit 24), so the two cooperate. baking the real
 * computed container-type is pixel-safe.
 */
import type { Captured } from '../../types';
import { pairedSubtrees } from '../match';

/**
 * preserves the container-type containment context on each element.
 *
 * @param captured - bakedStyles + clone are mutated in place
 */
export function apply(captured: Captured): Captured {
	for (const [original, clone] of pairedSubtrees(captured.root, captured.clone)) {
		const computed = getComputedStyle(original);
		const containerType = computed.getPropertyValue('container-type');
		// `normal` is the default (no containment); nothing to preserve.
		if (!containerType || containerType === 'normal') continue;

		const baked = captured.bakedStyles.get(clone) ?? new Map<string, string>();
		bake(clone, baked, 'container-type', containerType);
		const name = computed.getPropertyValue('container-name');
		if (name && name !== 'none') bake(clone, baked, 'container-name', name);
		captured.bakedStyles.set(clone, baked);
	}
	return captured;
}

/** record a value in the baked map and on the clone's inline style. */
function bake(clone: Element, baked: Map<string, string>, prop: string, value: string): void {
	if (baked.has(prop)) return;
	baked.set(prop, value);
	try {
		(clone as HTMLElement).style.setProperty(prop, value);
	} catch {
		// invalid for this element; skip.
	}
}
