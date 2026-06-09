/**
 * reconcile/bake.ts — style reconciliation (P1 authored-vs-computed)
 *
 * Phase: c (reconcile) — see SNIPCODE-REWRITE-PLAN.md section 12
 * Pipeline position: 2 — reconcile
 * Reads from Captured: root, clone, foundationRules, componentRules
 * Writes to Captured: bakedStyles (per clone element), clone (inline styles), warnings
 *
 * Principles applied: P1 (authored > computed when round-trip identical). P2 and
 * P4 are added in commit 7.
 *
 * Why this exists: the picked subtree's styles live in stylesheets that do not
 * travel with the snip. this module bakes the winning value of every authored
 * property onto each element so the snip renders standalone. it applies P1 per
 * property: if the authored value (from match.ts) reproduces the captured
 * computed value when forced onto the live element, ship the authored string —
 * preserving var()/clamp()/%/oklch()/calc(). if it does not (it lost the cascade
 * to an !important or higher-specificity rule we could not capture), ship the
 * computed value so pixel fidelity is locked at the capture viewport.
 *
 * the probe is the whole trick: it never trusts the matched cascade blindly, it
 * validates each decision against ground truth (getComputedStyle). that is why
 * this file needs no hand-curated property Sets, no per-tag branches, and no
 * is<X> predicates (the v1 cleaner/bake anti-patterns, forbidden patterns 1-3).
 */
import type { Captured } from '../types';
import { authoredCascade } from './match';

/**
 * runs reconcile: P1-bakes every element's authored cascade onto the detached
 * clone, recording the result in bakedStyles and writing inline styles so the
 * clone serializes to standalone html.
 *
 * @param captured — the capture; clone + bakedStyles are mutated in place
 */
export function reconcile(captured: Captured): void {
	const cascade = authoredCascade(captured);
	const originals = subtreeElements(captured.root);
	const clones = subtreeElements(captured.clone);
	if (originals.length !== clones.length) {
		// structural divergence should be impossible (clone is cloneNode(true)),
		// but if a feature mutated structure earlier, fail soft and bail rather
		// than mis-pair styles onto the wrong nodes.
		captured.warnings.push('bake: clone/original structure diverged; skipping reconcile');
		return;
	}

	for (let i = 0; i < originals.length; i++) {
		const original = originals[i];
		const clone = clones[i];
		if (!original || !clone) continue;
		const authored = cascade.get(original) ?? new Map<string, string>();
		const baked = bakeElement(original, authored);
		captured.bakedStyles.set(clone, baked);
		writeInline(clone, baked);
	}
}

/**
 * applies P1 to one element, returning its baked prop→value map.
 *
 * @param original — the live element (has document context for getComputedStyle)
 * @param authored — its winning authored values from the cascade
 */
function bakeElement(original: Element, authored: Map<string, string>): Map<string, string> {
	const baked = new Map<string, string>();
	const computedStyle = getComputedStyle(original);
	for (const [prop, authoredValue] of authored) {
		const computed = computedStyle.getPropertyValue(prop);
		// shorthands and custom props do not appear in computed style; we cannot
		// validate them against ground truth, so trust the authored value.
		if (computed === '') {
			baked.set(prop, authoredValue);
			continue;
		}
		// P1: ship authored only when it reproduces the captured computed value.
		if (reproducesComputed(original, prop, authoredValue, computed)) {
			baked.set(prop, authoredValue);
		} else {
			baked.set(prop, computed);
		}
	}
	return baked;
}

/**
 * tests whether forcing `value` onto the element's inline style reproduces the
 * captured computed value, in the element's real context (so rem/%/var resolve
 * correctly). transiently mutates then restores the live inline style within the
 * same synchronous frame, so the page never visibly changes.
 *
 * @returns true when the authored value round-trips (P1 keeps it)
 */
function reproducesComputed(el: Element, prop: string, value: string, computed: string): boolean {
	const style = (el as HTMLElement).style;
	if (!style) return false;
	const prev = style.getPropertyValue(prop);
	const prevPriority = style.getPropertyPriority(prop);
	try {
		style.setProperty(prop, value);
		return getComputedStyle(el).getPropertyValue(prop) === computed;
	} catch {
		return false;
	} finally {
		if (prev) style.setProperty(prop, prev, prevPriority);
		else style.removeProperty(prop);
	}
}

/** write a baked prop→value map onto a clone element as inline styles. */
function writeInline(clone: Element, baked: Map<string, string>): void {
	const style = (clone as HTMLElement).style;
	if (!style) return;
	for (const [prop, value] of baked) {
		try {
			style.setProperty(prop, value);
		} catch {
			// invalid declaration for this element; skip it rather than throw.
		}
	}
}

/** depth-first element list, root first — must match match.ts traversal order. */
function subtreeElements(root: Element): Element[] {
	const out: Element[] = [];
	const walk = (el: Element): void => {
		out.push(el);
		for (const child of Array.from(el.children)) walk(child);
	};
	walk(root);
	return out;
}
