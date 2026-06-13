/**
 * features/layers.ts: @layer / @property / @scope
 *
 * Pipeline position: reconcile
 * Reads from Captured: clone, bakedStyles, variables (used custom props)
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

/**
 * Re-emits @property registrations for custom properties the snip uses.
 *
 * @param captured - clone is mutated in place
 */
export function apply(captured: Captured): Captured {
	const used = usedCustomProps(captured);
	if (used.size === 0) return captured;

	const rules: string[] = [];
	for (const sheet of Array.from(document.styleSheets)) {
		let cssRules: CSSRuleList;
		try {
			cssRules = sheet.cssRules;
		} catch {
			continue; // Cross-origin sheet; cannot read.
		}
		collectPropertyRules(cssRules, used, rules);
	}
	if (rules.length === 0) return captured;

	const style = document.createElement('style');
	style.textContent = rules.join('\n');
	captured.clone.appendChild(style);
	return captured;
}

/** Every custom-property name the snip references or defines. */
function usedCustomProps(captured: Captured): Set<string> {
	const names = new Set<string>();
	for (const v of captured.variables) names.add(v.name);
	for (const [, baked] of captured.bakedStyles) {
		for (const [prop, value] of baked) {
			if (prop.startsWith('--')) names.add(prop);
			let m: RegExpExecArray | null;
			const re = /var\(\s*(--[A-Za-z0-9_-]+)/g;
			while ((m = re.exec(value)) !== null) if (m[1]) names.add(m[1]);
		}
	}
	return names;
}

/** Find @property rules (CSSPropertyRule) whose name is used and serialize them. */
function collectPropertyRules(rules: CSSRuleList, used: Set<string>, out: string[]): void {
	for (const rule of Array.from(rules)) {
		// CSSPropertyRule is not in all dom lib versions; detect structurally.
		const r = rule as unknown as { name?: unknown; syntax?: unknown; inherits?: unknown; initialValue?: unknown; cssText?: string };
		if (typeof r.name === 'string' && typeof r.syntax === 'string' && r.name.startsWith('--')) {
			if (used.has(r.name)) out.push(r.cssText ?? serializeProperty(r));
		} else if ('cssRules' in rule && (rule as { cssRules?: unknown }).cssRules instanceof CSSRuleList) {
			collectPropertyRules((rule as CSSRule & { cssRules: CSSRuleList }).cssRules, used, out);
		}
	}
}

/** Fallback serializer for an @property rule when cssText is unavailable. */
function serializeProperty(r: { name?: unknown; syntax?: unknown; inherits?: unknown; initialValue?: unknown }): string {
	const initial = typeof r.initialValue === 'string' && r.initialValue ? `\n\tinitial-value: ${r.initialValue};` : '';
	return `@property ${String(r.name)} {\n\tsyntax: ${String(r.syntax)};\n\tinherits: ${String(r.inherits)};${initial}\n}`;
}
