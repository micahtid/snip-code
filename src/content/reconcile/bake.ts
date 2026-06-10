/**
 * reconcile/bake.ts: style reconciliation (P1 authored-vs-computed)
 *
 * Phase: c (reconcile), see SNIPCODE-REWRITE-PLAN.md section 12
 * Pipeline position: 2, reconcile
 * Reads from Captured: root, clone, foundationRules, componentRules
 * Writes to Captured: bakedStyles (per clone element), clone (inline styles), warnings
 *
 * Principles applied: P1 (authored > computed when round-trip identical), P2
 * (inheritance crosses snip boundaries), P4 (escaped layout context gets baked).
 *
 * Why this exists: the picked subtree's styles live in stylesheets that do not
 * travel with the snip. this module bakes the winning value of every authored
 * property onto each element so the snip renders standalone.
 *
 * - P1 (per element): if the authored value (from match.ts) reproduces the
 *   captured computed value when forced onto the live element, ship the authored
 *   string, preserving var()/clamp()/%/oklch()/calc(). otherwise ship computed
 *   so pixel fidelity is locked at the capture viewport.
 * - P2 (snip root only): inherited properties whose computed value at the root
 *   diverges from the document default are baked onto the root, so they survive
 *   when the snip loses its ancestor chain. children inherit from the root
 *   automatically, so only the root needs them. the inherited-property list is
 *   read dynamically from the browser (a parent/child probe), never hardcoded , 
 *   forbidden pattern #1 bans property-name Sets, and the engine is the
 *   authoritative source of which properties inherit anyway.
 * - P4 (snip root only): if the root was a flex/grid item of a parent outside
 *   the snip, its box size came from that vanished context; we bake the root's
 *   resolved geometry so it renders at the same size standalone. no synthetic
 *   wrapper element, per P4.
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
 * @param captured - the capture; clone + bakedStyles are mutated in place
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

	// P2 + P4 act only on the snip root (index 0): inherited values flow down to
	// children automatically, and the escaped-layout box belongs to the root.
	const rootOriginal = originals[0];
	const rootClone = clones[0];
	if (rootOriginal && rootClone) {
		bakeRootContext(rootOriginal, rootClone, captured);
	}
}

/**
 * applies P2 (inherited divergence) and P4 (escaped layout) to the snip root.
 *
 * @param original - the live root element
 * @param clone - the corresponding clone node (receives the baked values)
 * @param captured - updates bakedStyles for the root clone
 */
function bakeRootContext(original: Element, clone: Element, captured: Captured): void {
	const baked = captured.bakedStyles.get(clone) ?? new Map<string, string>();
	bakeInheritedDivergence(original, baked); // P2
	bakeEscapedLayout(original, baked); // P4
	captured.bakedStyles.set(clone, baked);
	writeInline(clone, baked);
}

/**
 * P2: bakes inherited properties whose computed value at the root diverges from
 * the document default.
 *
 * for each property in the root's computed style, this asks the browser two
 * questions via a detached probe: does the property inherit, and does the root's
 * value differ from a fresh same-tag element's default? if both, the value would
 * be lost when the snip is reparented, so it is baked onto the root. P1-baked
 * authored values are left untouched (authored wins).
 *
 * @param original - the live root
 * @param baked - the root's baked map, extended in place
 */
function bakeInheritedDivergence(original: Element, baked: Map<string, string>): void {
	const rootComputed = getComputedStyle(original);
	// a same-tag element in a neutral parent gives both the ua default values and
	// the child probe for inheritance detection.
	const probeParent = document.createElement('div');
	const probeChild = document.createElement(original.tagName);
	probeParent.appendChild(probeChild);
	// off-screen but laid out, so getComputedStyle returns real values.
	probeParent.style.cssText = 'position:absolute;left:-99999px;top:-99999px;visibility:hidden';
	document.body.appendChild(probeParent);
	try {
		const childDefault = getComputedStyle(probeChild);
		for (let i = 0; i < rootComputed.length; i++) {
			const prop = rootComputed.item(i);
			if (!prop || baked.has(prop)) continue; // authored value already won (P1)
			const rootVal = rootComputed.getPropertyValue(prop);
			const defaultVal = childDefault.getPropertyValue(prop);
			if (rootVal === defaultVal) continue; // no divergence from default
			if (isInherited(probeParent, probeChild, prop, rootVal, defaultVal)) {
				baked.set(prop, rootVal);
			}
		}
	} finally {
		probeParent.remove();
	}
}

/**
 * dynamic inheritance test: sets `value` on the probe parent and checks whether
 * the probe child (which has no own declaration for the property) picks it up.
 * the value is the root's own computed value, always a valid css value for the
 * property, so the probe never needs a per-property sentinel.
 *
 * @returns true when the property inherits (and is therefore divergence-prone)
 */
function isInherited(parent: HTMLElement, child: Element, prop: string, value: string, defaultVal: string): boolean {
	// if the root value equals the default we never get here, so value!==default;
	// that makes the child's pickup observable.
	parent.style.setProperty(prop, value);
	try {
		const childNow = getComputedStyle(child).getPropertyValue(prop);
		return childNow === value && childNow !== defaultVal;
	} finally {
		parent.style.removeProperty(prop);
	}
}

/**
 * P4: when the root was a flex/grid item of a parent outside the snip, its used
 * width/height came from that vanished container. bake the resolved geometry so
 * the root keeps its size standalone. no synthetic wrapper is created (P4).
 *
 * width/height are named explicitly here because they are the specific geometry
 * a flex/grid container imposes on its items (a bounded css-spec mechanism, not a
 * curated heuristic Set), and only when the escaped-context condition holds.
 *
 * @param original - the live root
 * @param baked - the root's baked map, extended in place
 */
function bakeEscapedLayout(original: Element, baked: Map<string, string>): void {
	const parent = original.parentElement;
	if (!parent) return;
	const parentDisplay = getComputedStyle(parent).display;
	const escaped = parentDisplay.includes('flex') || parentDisplay.includes('grid');
	if (!escaped) return;
	const computed = getComputedStyle(original);
	// only lock geometry the author did not already set explicitly (P1 owns those).
	for (const prop of ['width', 'height']) {
		if (baked.has(prop)) continue;
		const value = computed.getPropertyValue(prop);
		if (value) baked.set(prop, value);
	}
}

/**
 * applies P1 to one element, returning its baked prop→value map.
 *
 * @param original - the live element (has document context for getComputedStyle)
 * @param authored - its winning authored values from the cascade
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

/** depth-first element list, root first, must match match.ts traversal order. */
function subtreeElements(root: Element): Element[] {
	const out: Element[] = [];
	const walk = (el: Element): void => {
		out.push(el);
		for (const child of Array.from(el.children)) walk(child);
	};
	walk(root);
	return out;
}
