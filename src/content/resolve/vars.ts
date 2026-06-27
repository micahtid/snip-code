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
import { synthesizedStyle, forEachSynthesizedDeclaration, rewriteSynthesizedDeclarations } from '../reconcile/synthesized';

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

	// Synthesized state/pseudo rules carry their own var() references, which the
	// bakedStyles loop above never sees (they live in a <style>, not in bakedStyles).
	// Resolve them with the same survival rule, with one state-specific exception
	// (see resolveSynthesizedVariables).
	resolveSynthesizedVariables(captured, subtreeDefs, rootVars, neededRootVars);

	emitRootVars(captured, rootVars, closeOver(neededRootVars, rootVars));
}

/**
 * Resolves the var() references inside the synthesized <style> (the state and pseudo
 * rules). A reference whose definition survives the snip is kept verbatim and renders
 * standalone: a subtree-scoped definition already travels on its clone node, and a
 * :root definition is marked needed so it is re-emitted on the root.
 *
 * The state-specific exception is the subtle one: a definition OUTSIDE the snip cannot be
 * resolved the way a resting declaration is. A resting var() is replaced by the live
 * element's computed literal, but that literal is the element's RESTING value — wrong for
 * a `:hover { color: var(--accent-hover) }` whose accent only takes its hover value while
 * hovered. There is no correct literal to copy (only a forced-state measurement could get
 * it, the deferred follow-up), so the declaration is dropped with a warning rather than
 * baked to a wrong color.
 *
 * A synthesized rule may also define its OWN custom properties (`:hover { --x: red;
 * color: var(--x) }`, or the tailwind ring's `--tw-ring-*` chain): those travel in the
 * same <style>, so a reference to one survives when that definition itself survives. The
 * survivable set is therefore computed to a fixpoint, and a declaration is dropped only if
 * it references a variable that survives nowhere — which also drops, transitively, any
 * declaration that depended on a dropped one, so no dangling var() is ever emitted.
 *
 * @param captured - the synthesized <style> is rewritten in place; warnings appended
 * @param subtreeDefs - custom-property names defined on a subtree element
 * @param rootVars - the :root custom properties available to re-emit
 * @param neededRootVars - accumulates the :root vars a kept reference depends on
 */
function resolveSynthesizedVariables(
	captured: Captured,
	subtreeDefs: Set<string>,
	rootVars: Map<string, string>,
	neededRootVars: Set<string>,
): void {
	const style = synthesizedStyle(captured);
	if (!style || !(style.textContent ?? '').includes('var(')) return;

	// Custom properties the synthesized rules define themselves, name -> its value(s).
	const synthDefs = new Map<string, string[]>();
	forEachSynthesizedDeclaration(captured, (decl) => {
		if (!decl.prop.startsWith('--')) return;
		synthDefs.set(decl.prop, [...(synthDefs.get(decl.prop) ?? []), decl.value]);
	});

	const survivable = (name: string, synthOk: Set<string>): boolean =>
		subtreeDefs.has(name) || rootVars.has(name) || synthOk.has(name);

	// Fixpoint: a synth-defined var survives once one of its definitions references only
	// survivable variables. Re-scan until no new name becomes survivable.
	const survivableSynth = new Set<string>();
	for (let changed = true; changed; ) {
		changed = false;
		for (const [name, values] of synthDefs) {
			if (survivableSynth.has(name)) continue;
			if (values.some((v) => referencedVars(v).every((r) => survivable(r, survivableSynth)))) {
				survivableSynth.add(name);
				changed = true;
			}
		}
	}

	rewriteSynthesizedDeclarations(captured, (decl) => {
		if (!decl.value.includes('var(')) return decl.value;
		const refs = referencedVars(decl.value);
		if (!refs.every((r) => survivable(r, survivableSynth))) {
			captured.warnings.push(
				`states: dropped "${decl.prop}" in "${decl.selector}"; its var() is defined outside the snip and has no resting-safe value`,
			);
			return null;
		}
		for (const r of refs) if (rootVars.has(r)) neededRootVars.add(r); // Keep the :root deps alive.
		return decl.value;
	});
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
