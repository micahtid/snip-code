/**
 * resolve/vars.ts: css custom property resolution
 *
 * Pipeline position: resolve
 * Reads from Captured: root, clone, bakedStyles, variables
 * Writes to Captured: bakedStyles and clone; resolves var() refs and emits root vars
 *
 * Variables travel with their definitions, or resolve to literals.
 *
 * Why this exists: earlier baking deliberately preserved authored var() references
 * on the baked elements. But a var() only renders if its definition survives into the
 * emitted snip. A definition survives when it lives on :root (re-emitted onto the
 * snip root here) or on an element inside the snip subtree (already inline on
 * that clone node). A definition on an ancestor *outside* the subtree does not
 * survive serialization, so its references are resolved to the computed literal
 * read from the live element, which already resolved them in-page.
 *
 * Single pass: every reference is decided in one sweep.
 * The only loop is computing the dependency closure of the root vars we keep,
 * that is resolving a definition's own var() deps, not a second orphan-recovery
 * pass over the output.
 */
import type { Captured } from '../types';
import { pairedSubtrees } from '../reconcile/match';
import { synthesizedStyle, forEachSynthesizedDeclaration, rewriteSynthesizedDeclarations } from '../reconcile/synthesized';
import { registeredProperties } from '../reconcile/properties';

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
	// Ambient definitions a state rule may also lean on: every foundation-scoped custom
	// property, meaning the `*`/html/body resets, for example older tailwind's `--tw-translate-x: 0`
	// transform chain, on top of :root. Those resets carry no @property registration, so
	// they inherit; re-emitting a referenced one on the root carries it to the subject. Used
	// only by the state path; the resting path below still resolves an outside-snip var to
	// its computed literal, unchanged.
	const ambientVars = new Map<string, string>(rootVars);
	for (const rule of captured.foundationRules) {
		for (const [prop, value] of rule.properties) {
			if (prop.startsWith('--') && !ambientVars.has(prop)) ambientVars.set(prop, value);
		}
	}
	// Definitions declared on some element inside the snip subtree already travel
	// with that clone node; they were baked as inline custom properties.
	const subtreeDefs = collectSubtreeDefs(captured);

	const neededRootVars = new Set<string>();
	const neededAmbientVars = new Set<string>();

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
				// computed literal is the faithful replacement and locks the pixel.
				const literal = getComputedStyle(original).getPropertyValue(prop);
				if (literal) {
					baked.set(prop, literal);
					setInline(clone, prop, literal);
				}
			}
		}
	}

	// Synthesized state/pseudo rules carry their own var() references, which the
	// bakedStyles loop above never sees; they live in a <style>, not in bakedStyles.
	// Resolve them against the ambient definitions, with one state-specific exception;
	// see resolveSynthesizedVariables.
	resolveSynthesizedVariables(captured, subtreeDefs, ambientVars, neededAmbientVars);

	// Re-emit every ambient definition a surviving reference needs: the resting :root deps
	// and the state-rule deps alike, each with its own dependency closure.
	const needed = new Set<string>([...closeOver(neededRootVars, rootVars), ...closeOver(neededAmbientVars, ambientVars)]);
	emitAmbientVars(captured, ambientVars, needed);
}

/**
 * Resolves the var() references inside the synthesized <style>, meaning the state and pseudo
 * rules. A reference whose definition survives the snip is kept verbatim and renders
 * standalone: a subtree-scoped definition already travels on its clone node, and a
 * :root definition is marked needed so it is re-emitted on the root.
 *
 * A reference resolves in the standalone artifact through any of the ways a value
 * legitimately reaches it, so a declaration is kept whenever all of its references do:
 *  - a surviving definition: a subtree-baked value, a re-emitted ambient definition that is
 *    :root or foundation/`*`-scoped, or a custom property the synthesized rules define
 *    themselves, as in `:hover { --x: red; color: var(--x) }` or the tailwind `--tw-*` chain,
 *    resolved to a fixpoint so a chain of synthesized defs holds;
 *  - a registered @property initial-value: `var(--x)` yields the registered initial even
 *    when nothing sets it, and reconcile/properties.ts ships those registrations;
 *  - a fallback on the reference itself: `var(--x, black)` always produces a value.
 *
 * Only a reference that resolves through none of these is unreproducible: its state-time
 * value cannot be copied, because the live element's computed value is its RESTING value,
 * wrong for a `:hover { color: var(--accent-hover) }` whose accent only takes its hover
 * value while hovered; only a forced-state measurement could get it, the deferred
 * follow-up. That declaration is dropped with a warning rather than baked to a wrong
 * color. Dropping is transitive through the fixpoint, so no dangling var() is ever emitted.
 *
 * @param captured - the synthesized <style> is rewritten in place; warnings appended
 * @param subtreeDefs - custom-property names defined on a subtree element
 * @param ambientVars - the :root + foundation custom properties available to re-emit
 * @param neededAmbientVars - accumulates the ambient vars a kept reference depends on
 */
function resolveSynthesizedVariables(
	captured: Captured,
	subtreeDefs: Set<string>,
	ambientVars: Map<string, string>,
	neededAmbientVars: Set<string>,
): void {
	const style = synthesizedStyle(captured);
	if (!style || !(style.textContent ?? '').includes('var(')) return;

	const registered = registeredProperties();
	// A reference resolves when its name has a surviving definition, whether subtree, ambient,
	// or synthesized, or a registered @property initial-value, or when the reference carries
	// its own fallback.
	const nameResolves = (name: string, synthOk: Set<string>): boolean =>
		subtreeDefs.has(name) || ambientVars.has(name) || synthOk.has(name) || registered.get(name)?.initialValue != null;
	const valueResolves = (value: string, synthOk: Set<string>): boolean =>
		varRefs(value).every((ref) => ref.hasFallback || nameResolves(ref.name, synthOk));

	// Custom properties the synthesized rules define themselves, name -> its values.
	const synthDefs = new Map<string, string[]>();
	forEachSynthesizedDeclaration(captured, (decl) => {
		if (!decl.prop.startsWith('--')) return;
		synthDefs.set(decl.prop, [...(synthDefs.get(decl.prop) ?? []), decl.value]);
	});

	// Fixpoint: a synth-defined var survives once one of its definitions resolves. Re-scan
	// until no new name becomes survivable.
	const survivableSynth = new Set<string>();
	for (let changed = true; changed; ) {
		changed = false;
		for (const [name, values] of synthDefs) {
			if (survivableSynth.has(name)) continue;
			if (values.some((v) => valueResolves(v, survivableSynth))) {
				survivableSynth.add(name);
				changed = true;
			}
		}
	}

	rewriteSynthesizedDeclarations(captured, (decl) => {
		if (!decl.value.includes('var(')) return decl.value;
		if (!valueResolves(decl.value, survivableSynth)) {
			captured.warnings.push(
				`states: dropped "${decl.prop}" in "${decl.selector}"; its var() is defined outside the snip and has no resting-safe value`,
			);
			return null;
		}
		// Keep the ambient deps a surviving reference needs.
		for (const ref of varRefs(decl.value)) if (ambientVars.has(ref.name)) neededAmbientVars.add(ref.name);
		return decl.value;
	});
}

/**
 * Every var() reference in a value, each with whether it carries a fallback, meaning a top-level
 * comma inside its own parens. A reference with a fallback always yields a value, so it
 * never forces a declaration to drop; one without a fallback must resolve by name.
 *
 * @param value - the declaration value to scan
 */
function varRefs(value: string): Array<{ name: string; hasFallback: boolean }> {
	const refs: Array<{ name: string; hasFallback: boolean }> = [];
	let i = value.indexOf('var(');
	while (i !== -1) {
		let depth = 0;
		let hasFallback = false;
		let j = i + 3; // The '(' of var(.
		for (; j < value.length; j++) {
			const ch = value[j];
			if (ch === '(') depth++;
			else if (ch === ')') { depth--; if (depth === 0) { j++; break; } }
			else if (ch === ',' && depth === 1) hasFallback = true; // A comma directly inside var()'s parens.
		}
		const name = /^\s*(--[A-Za-z0-9_-]+)/.exec(value.slice(i + 4, j));
		if (name?.[1]) refs.push({ name: name[1], hasFallback });
		i = value.indexOf('var(', j);
	}
	return refs;
}

/**
 * Re-emit the surviving ambient custom properties, the :root and foundation-scoped
 * definitions a reference needs, onto the snip root clone, where they inherit down to the
 * subtree. The :root ones also flip their source-of-truth flag for transparency.
 *
 * @param captured - bakedStyles + clone mutated in place
 * @param ambientVars - the ambient definitions, name -> value
 * @param needed - the names to emit (already dependency-closed)
 */
function emitAmbientVars(captured: Captured, ambientVars: Map<string, string>, needed: Set<string>): void {
	const rootClone = captured.clone;
	const baked = captured.bakedStyles.get(rootClone) ?? new Map<string, string>();
	for (const name of needed) {
		const value = ambientVars.get(name);
		if (value === undefined || baked.has(name)) continue;
		baked.set(name, value);
		setInline(rootClone, name, value);
		// Flip the source-of-truth flag for the :root ones, for transparency/emit.
		for (const v of captured.variables) if (v.name === name && v.scope === 'root') v.resolved = true;
	}
	captured.bakedStyles.set(rootClone, baked);
}

/**
 * Expands a set of needed root vars to include the vars their own values
 * reference, since a root var may be defined in terms of another. This is a
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
