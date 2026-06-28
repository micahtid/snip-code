/**
 * features/layers.ts: @layer / @property / @scope
 *
 * Pipeline position: reconcile
 * Reads from Captured: clone, bakedStyles, variables, and the synthesized <style> (used
 *   custom props); the @property scan itself lives in reconcile/properties.ts
 * Writes to Captured: clone (appends an @property <style>), warnings
 *
 * A feature handler for the cascade-layering and registered-property mechanisms.
 *
 * CSS/spec reference: https://developer.mozilla.org/en-US/docs/Web/CSS/@property
 * Detection criterion: a registered @property in the document whose name is a
 * custom property the snip uses. Early-returns when none match.
 * Transform contract: appends a <style> of the matching @property rules to the
 * clone. Reads document.styleSheets (in-memory cssom). Clone only.
 * Test bundle: TODO, add later (animated @property gradient angle).
 *
 * Why this exists: @layer order and @scope are already resolved into the baked
 * inline styles, match.ts builds the cascade and bake.ts's probe validates
 * every value against the computed result, which the browser produced with layer
 * and scope precedence applied. So they need no separate handling. @property is
 * the part that does not survive: a registered custom property carries a syntax,
 * inherits flag, and initial-value that govern how it falls back and interpolates
 * (e.g. an animated --angle gradient). Re-emitting the @property registration
 * keeps that behavior. (Only the syntax registration is re-emitted, not a
 * synthetic layer order.)
 */
import type { Captured } from '../../types';
import { registeredProperties } from '../properties';
import { forEachSynthesizedDeclaration } from '../synthesized';

const VAR_REF = /var\(\s*(--[A-Za-z0-9_-]+)/g;

/**
 * Re-emits @property registrations for custom properties the snip uses.
 *
 * @param captured - clone is mutated in place
 */
export function apply(captured: Captured): Captured {
	const used = usedCustomProps(captured);
	if (used.size === 0) return captured;

	const rules: string[] = [];
	for (const [name, prop] of registeredProperties()) {
		if (used.has(name)) rules.push(prop.cssText);
	}
	if (rules.length === 0) return captured;

	const style = document.createElement('style');
	style.textContent = rules.join('\n');
	captured.clone.appendChild(style);
	return captured;
}

/**
 * Every custom-property name the snip references or defines, across the baked styles and
 * the synthesized state/pseudo rules. The synthesized rules are included so a registered
 * property a state rule depends on (the tailwind ring/shadow chain) keeps its @property
 * registration in the artifact, which is what lets resolve/vars.ts treat it as resolvable.
 *
 * @param captured - the capture whose baked + synthesized styles are scanned
 */
function usedCustomProps(captured: Captured): Set<string> {
	const names = new Set<string>();
	const addRefs = (value: string): void => {
		let m: RegExpExecArray | null;
		VAR_REF.lastIndex = 0;
		while ((m = VAR_REF.exec(value)) !== null) if (m[1]) names.add(m[1]);
	};
	for (const v of captured.variables) names.add(v.name);
	for (const [, baked] of captured.bakedStyles) {
		for (const [prop, value] of baked) {
			if (prop.startsWith('--')) names.add(prop);
			addRefs(value);
		}
	}
	forEachSynthesizedDeclaration(captured, (decl) => {
		if (decl.prop.startsWith('--')) names.add(decl.prop);
		addRefs(decl.value);
	});
	return names;
}
