/**
 * reconcile/synthesized.ts: the shared synthesized-<style> carrier
 *
 * Pipeline position: reconcile; a shared helper for the feature handlers
 * Reads from Captured: clone, warnings
 * Writes to Captured: clone, one appended <style>, and warnings
 *
 * Why this exists: two feature handlers express what an inline style cannot, and so
 * both ship a real css rule rather than a property: pseudo.ts materializes
 * ::before/::marker content, and states.ts reproduces :hover/:focus/:active. Each
 * needs the identical plumbing: a marker re-anchored rule appended to a <style> on
 * the clone, later lifted into the document head by convert/format.ts. Rather than
 * each handler create and manage its own <style>, the v1-era copy-paste, they share
 * one carrier here: a single appended <style> collects every synthesized rule, which
 * also gives the resolve phase one place to find and rewrite those rules' url()/var()
 * references; see resolve/inline.ts and resolve/vars.ts.
 *
 * The carrier is tagged with a data-* attribute so the resolve passes can locate it
 * and convert/format.ts strips it on lift; it never reaches the emitted markup.
 */
import type { Captured } from '../types';

/** Marks the single synthesized <style> on the clone, so resolve can find it and lift can strip it. */
const SYNTH_MARKER = 'data-snip-synth';

/**
 * Void elements serialize no child nodes, since `<input>` has no closing tag, so a <style>
 * appended to a void snip root would be silently dropped by outerHTML. The handlers warn
 * rather than lose the rules without trace.
 */
const VOID_TAGS = new Set([
	'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
	'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/**
 * Appends synthesized css rules to the clone's single shared <style>, creating it on
 * first use. Both pseudo.ts and states.ts feed this, so every synthesized rule lands in
 * one block in handler order.
 *
 * @param captured - clone + warnings mutated in place
 * @param rules - complete css rule strings (`selector {... }`), already formatted
 */
export function appendSynthesizedRules(captured: Captured, rules: string[]): void {
	if (rules.length === 0) return;
	// A void root cannot carry a child <style>; the rules cannot attach to the artifact.
	if (VOID_TAGS.has(captured.clone.tagName.toLowerCase())) {
		captured.warnings.push(
			`reconcile: ${rules.length} synthesized rule(s) could not attach to a void root <${captured.clone.tagName.toLowerCase()}>`,
		);
		return;
	}
	const style = synthesizedStyle(captured) ?? createSynthesizedStyle(captured);
	const existing = style.textContent ?? '';
	style.textContent = existing ? `${existing}\n${rules.join('\n')}` : rules.join('\n');
}

/**
 * The clone's synthesized <style>, or null if no handler has created one. The resolve
 * passes use this to rewrite the synthesized rules' resource references.
 *
 * @param captured - the capture whose clone is searched
 */
export function synthesizedStyle(captured: Captured): HTMLStyleElement | null {
	return captured.clone.querySelector(`style[${SYNTH_MARKER}]`);
}

/** Creates the marked synthesized <style> as a child of the clone root. */
function createSynthesizedStyle(captured: Captured): HTMLStyleElement {
	const style = document.createElement('style');
	style.setAttribute(SYNTH_MARKER, '');
	captured.clone.appendChild(style);
	return style;
}

/** One declaration of a synthesized rule, with the selector it belongs to. */
export interface SynthesizedDeclaration {
	/** The owning rule's selector, e.g. `[data-snip-state="0"]:hover`. */
	selector: string;
	/** The longhand or shorthand property name. */
	prop: string;
	/** The declaration value, without any `!important`. */
	value: string;
	/** Whether the declaration carries `!important`. */
	important: boolean;
}

/** One parsed synthesized rule: its selector and the declarations under it. */
interface SynthesizedRule {
	selector: string;
	declarations: SynthesizedDeclaration[];
}

/**
 * Walks every declaration in the synthesized <style>, read-only. The resolve passes use
 * this to gather the url()/var() references the synthesized rules carry, which the
 * resting bake never sees because these rules live in a <style>, not in bakedStyles.
 *
 * @param captured - the capture whose synthesized <style> is read
 * @param fn - called once per declaration
 */
export function forEachSynthesizedDeclaration(captured: Captured, fn: (decl: SynthesizedDeclaration) => void): void {
	const style = synthesizedStyle(captured);
	if (!style) return;
	for (const rule of parseSynthesized(style)) for (const decl of rule.declarations) fn(decl);
}

/**
 * Rewrites the synthesized <style> declaration by declaration: the transform returns a
 * replacement value (or the same value to keep it), or null to drop the declaration
 * entirely. A rule left with no declarations is removed.
 *
 * Parsing is line-based over the exact shape the handlers emit (one `\tprop: value;` per
 * line), deliberately not a cssom round-trip: a shorthand carrying a var()
 * (`background: var(--x)`) is not enumerable as longhands through the cssom, so a re-serialize
 * would silently drop it. Working on the emitted text preserves every declaration verbatim
 * except the one the transform changes.
 *
 * This is the single place the resolve phase mutates synthesized rules: resolve/inline.ts
 * rewrites their url() to data uris, and resolve/vars.ts drops a declaration whose var()
 * is defined outside the snip, which cannot be resolved by copying; see resolve/vars.ts.
 *
 * @param captured - the capture whose synthesized <style> is rewritten in place
 * @param transform - maps a declaration's value to a new value, or null to drop it
 */
export function rewriteSynthesizedDeclarations(
	captured: Captured,
	transform: (decl: SynthesizedDeclaration) => string | null,
): void {
	const style = synthesizedStyle(captured);
	if (!style) return;
	const blocks: string[] = [];
	for (const rule of parseSynthesized(style)) {
		const lines: string[] = [];
		for (const decl of rule.declarations) {
			const next = transform(decl);
			if (next === null) continue;
			lines.push(`\t${decl.prop}: ${next}${decl.important ? ' !important' : ''};`);
		}
		if (lines.length > 0) blocks.push(`${rule.selector} {\n${lines.join('\n')}\n}`);
	}
	style.textContent = blocks.join('\n');
}

/**
 * Parses the synthesized <style> text into rules and declarations. The text is always in
 * the handlers' own one-declaration-per-line shape, so a line parser is exact and avoids
 * the cssom's shorthand-with-var() loss; see rewriteSynthesizedDeclarations.
 *
 * @param style - the synthesized <style> element
 */
function parseSynthesized(style: HTMLStyleElement): SynthesizedRule[] {
	const rules: SynthesizedRule[] = [];
	let current: SynthesizedRule | null = null;
	for (const line of (style.textContent ?? '').split('\n')) {
		const trimmed = line.trim();
		if (trimmed === '') continue;
		if (trimmed.endsWith('{')) {
			current = { selector: trimmed.slice(0, -1).trim(), declarations: [] };
			rules.push(current);
		} else if (trimmed === '}') {
			current = null;
		} else if (current) {
			const decl = parseDeclaration(current.selector, trimmed);
			if (decl) current.declarations.push(decl);
		}
	}
	return rules;
}

/** Parse one `prop: value;` or `prop: value !important;` declaration line. */
function parseDeclaration(selector: string, line: string): SynthesizedDeclaration | null {
	const text = line.replace(/;$/, '');
	const colon = text.indexOf(':'); // The first colon; a url(http:) in the value cannot precede it.
	if (colon === -1) return null;
	const prop = text.slice(0, colon).trim();
	let value = text.slice(colon + 1).trim();
	const important = /!\s*important$/i.test(value);
	if (important) value = value.replace(/!\s*important$/i, '').trim();
	if (!prop || !value) return null;
	return { selector, prop, value, important };
}
