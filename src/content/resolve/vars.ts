/**
 * resolve/vars.ts — css custom property resolution (P3, single pass)
 *
 * Phase: d (resolve) — see SNIPCODE-REWRITE-PLAN.md section 12
 * Pipeline position: 3 — resolve
 * Reads from Captured: root, clone, bakedStyles, variables
 * Writes to Captured: bakedStyles + clone (resolves var() refs; emits root vars)
 *
 * Principles applied: P3 (variables travel with definitions, or resolve to literals).
 *
 * Why this exists: P1 deliberately preserved authored var() references on the
 * baked elements. but a var() only renders if its definition survives into the
 * emitted snip. a definition survives when it lives on :root (re-emitted onto the
 * snip root here) or on an element inside the snip subtree (already inline on
 * that clone node). a definition on an ancestor *outside* the subtree does not
 * survive serialization, so its references are resolved to the computed literal
 * (read from the live element, which already resolved them in-page).
 *
 * single pass (forbidden pattern #9): every reference is decided in one sweep.
 * the only loop is computing the dependency closure of the root vars we keep —
 * that is resolving a definition's own var() deps, not a second orphan-recovery
 * pass over the output.
 */
import type { Captured } from '../types';

const VAR_REF = /var\(\s*(--[A-Za-z0-9_-]+)/g;

/**
 * resolves every var() reference in the baked styles per P3.
 *
 * @param captured — clone + bakedStyles are mutated in place
 */
export function resolveVariables(captured: Captured): void {
	const cloneToOriginal = pairSubtrees(captured.root, captured.clone);

	// :root / html scoped definitions; survive only if we re-emit them.
	const rootVars = new Map<string, string>();
	for (const v of captured.variables) {
		if (v.scope === 'root') rootVars.set(v.name, v.value);
	}
	// definitions declared on some element inside the snip subtree already travel
	// with that clone node (they were baked as inline custom properties).
	const subtreeDefs = collectSubtreeDefs(captured);

	const neededRootVars = new Set<string>();

	for (const [clone, baked] of captured.bakedStyles) {
		const original = cloneToOriginal.get(clone) ?? null;
		for (const [prop, value] of baked) {
			if (!value.includes('var(')) continue;
			const names = referencedVars(value);
			let mustResolveToLiteral = false;
			for (const name of names) {
				if (subtreeDefs.has(name)) continue; // survives in subtree
				if (rootVars.has(name)) {
					neededRootVars.add(name); // survives once re-emitted on the root
					continue;
				}
				mustResolveToLiteral = true; // defined outside the snip; cannot survive
			}
			if (mustResolveToLiteral && original) {
				// the live element already resolved the var to its used value; that
				// computed literal is the faithful replacement (locks the pixel).
				const literal = getComputedStyle(original).getPropertyValue(prop);
				if (literal) {
					baked.set(prop, literal);
					setInline(clone, prop, literal);
				}
			}
		}
	}

	emitRootVars(captured, rootVars, closeOver(neededRootVars, rootVars));
}

/** re-emit the surviving :root custom properties onto the snip root clone. */
function emitRootVars(captured: Captured, rootVars: Map<string, string>, needed: Set<string>): void {
	const rootClone = captured.clone;
	const baked = captured.bakedStyles.get(rootClone) ?? new Map<string, string>();
	for (const name of needed) {
		const value = rootVars.get(name);
		if (value === undefined || baked.has(name)) continue;
		baked.set(name, value);
		setInline(rootClone, name, value);
		// flip the source-of-truth flag for transparency/emit.
		for (const v of captured.variables) if (v.name === name && v.scope === 'root') v.resolved = true;
	}
	captured.bakedStyles.set(rootClone, baked);
}

/**
 * expands a set of needed root vars to include the vars their own values
 * reference (a root var may be defined in terms of another). this is a
 * dependency closure within the definitions, not a second pass over the output.
 */
function closeOver(initial: Set<string>, rootVars: Map<string, string>): Set<string> {
	const needed = new Set<string>();
	const queue = [...initial];
	while (queue.length > 0) {
		const name = queue.pop();
		if (!name || needed.has(name)) continue;
		needed.add(name);
		const value = rootVars.get(name);
		if (!value) continue;
		for (const dep of referencedVars(value)) {
			if (rootVars.has(dep) && !needed.has(dep)) queue.push(dep);
		}
	}
	return needed;
}

/** every --name referenced by var() in a value string. */
function referencedVars(value: string): string[] {
	const names: string[] = [];
	let m: RegExpExecArray | null;
	VAR_REF.lastIndex = 0;
	while ((m = VAR_REF.exec(value)) !== null) {
		if (m[1]) names.push(m[1]);
	}
	return names;
}

/** all custom-property names defined on any element inside the snip subtree. */
function collectSubtreeDefs(captured: Captured): Set<string> {
	const defs = new Set<string>();
	for (const [, baked] of captured.bakedStyles) {
		for (const prop of baked.keys()) {
			if (prop.startsWith('--')) defs.add(prop);
		}
	}
	return defs;
}

/** map each clone element to its live original by lockstep subtree walk. */
function pairSubtrees(root: Element, clone: Element): Map<Element, Element> {
	const originals = subtreeElements(root);
	const clones = subtreeElements(clone);
	const map = new Map<Element, Element>();
	const n = Math.min(originals.length, clones.length);
	for (let i = 0; i < n; i++) {
		const o = originals[i];
		const c = clones[i];
		if (o && c) map.set(c, o);
	}
	return map;
}

/** depth-first element list, root first — matches the reconcile traversal order. */
function subtreeElements(root: Element): Element[] {
	const out: Element[] = [];
	const walk = (el: Element): void => {
		out.push(el);
		for (const child of Array.from(el.children)) walk(child);
	};
	walk(root);
	return out;
}

/** safely set a property on a clone element's inline style. */
function setInline(clone: Element, prop: string, value: string): void {
	try {
		(clone as HTMLElement).style.setProperty(prop, value);
	} catch {
		// invalid declaration for this element; ignore.
	}
}
