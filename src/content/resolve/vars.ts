/**
 * resolve/vars.ts: css custom property resolution
 *
 * Pipeline position: resolve
 * Reads from Captured: root, clone, bakedStyles, variables
 * Writes to Captured: bakedStyles + clone (resolves var() refs; emits root vars)
 *
 * Variables travel with their definitions, or resolve to literals.
 *
 * Why this exists: earlier baking deliberately preserved authored var() references
 * on the baked elements. But a var() only renders if its definition survives into the
 * emitted snip. A definition survives when it lives on :root (re-emitted onto the
 * snip root here) or on an element inside the snip subtree (already inline on
 * that clone node). A definition on an ancestor *outside* the subtree does not
 * survive serialization, so its references are resolved to the computed literal
 * (read from the live element, which already resolved them in-page).
 *
 * Single pass: every reference is decided in one sweep.
 * The only loop is computing the dependency closure of the root vars we keep,
 * that is resolving a definition's own var() deps, not a second orphan-recovery
 * pass over the output.
 */
import type { Captured } from '../types';
import { pairedSubtrees } from '../reconcile/match';

const VAR_REF = /var\(\s*(--[A-Za-z0-9_-]+)/g;

/**
 * Resolves every var() reference in the baked styles: a reference is kept if its
 * definition lives inside the snip, otherwise resolved to its computed literal.
 *
 * @param captured - clone + bakedStyles are mutated in place
 */
export function resolveVariables(captured: Captured): void {
	const cloneToOriginal = new Map<Element, Element>(
		pairedSubtrees(captured.root, captured.clone).map(([original, clone]) => [clone, original]),
	);

	// :root / html scoped definitions; survive only if we re-emit them.
	const rootVars = new Map<string, string>();
	for (const v of captured.variables) {
		if (v.scope === 'root') rootVars.set(v.name, v.value);
	}
	// Definitions declared on some element inside the snip subtree already travel
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
				if (subtreeDefs.has(name)) continue; // Survives in subtree
				if (rootVars.has(name)) {
					neededRootVars.add(name); // Survives once re-emitted on the root
					continue;
				}
				mustResolveToLiteral = true; // Defined outside the snip; cannot survive
			}
			if (mustResolveToLiteral && original) {
				// The live element already resolved the var to its used value; that
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

/** Re-emit the surviving :root custom properties onto the snip root clone. */
function emitRootVars(captured: Captured, rootVars: Map<string, string>, needed: Set<string>): void {
	const rootClone = captured.clone;
	const baked = captured.bakedStyles.get(rootClone) ?? new Map<string, string>();
	for (const name of needed) {
		const value = rootVars.get(name);
		if (value === undefined || baked.has(name)) continue;
		baked.set(name, value);
		setInline(rootClone, name, value);
		// Flip the source-of-truth flag for transparency/emit.
		for (const v of captured.variables) if (v.name === name && v.scope === 'root') v.resolved = true;
	}
	captured.bakedStyles.set(rootClone, baked);
}

/**
 * Expands a set of needed root vars to include the vars their own values
 * reference (a root var may be defined in terms of another). This is a
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

/** Every --name referenced by var() in a value string. */
function referencedVars(value: string): string[] {
	const names: string[] = [];
	let m: RegExpExecArray | null;
	VAR_REF.lastIndex = 0;
	while ((m = VAR_REF.exec(value)) !== null) {
		if (m[1]) names.push(m[1]);
	}
	return names;
}

/** All custom-property names defined on any element inside the snip subtree. */
function collectSubtreeDefs(captured: Captured): Set<string> {
	const defs = new Set<string>();
	for (const [, baked] of captured.bakedStyles) {
		for (const prop of baked.keys()) {
			if (prop.startsWith('--')) defs.add(prop);
		}
	}
	return defs;
}

/** Safely set a property on a clone element's inline style. */
function setInline(clone: Element, prop: string, value: string): void {
	try {
		(clone as HTMLElement).style.setProperty(prop, value);
	} catch {
		// Invalid declaration for this element; ignore.
	}
}
