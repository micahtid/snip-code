/**
 * minimize/inline.ts: inline the custom-property dumps
 *
 * Pipeline position: minimize, after the at-rule purge and before format
 * Reads from Captured: page.viewport via the oracle; warnings on graceful skip
 * Writes to Captured: nothing; transforms the stylesheet string
 *
 * Why this exists: the reproduce phase bakes a wall of custom properties, `--text-sm`,
 * `--border`, `--spacing`, onto the emitted rules and then reads them back through var(),
 * an indirection a human writing this by hand would not keep. This phase resolves each
 * `var(--x)` to the value it actually holds at that site, read from the mounted frame, and
 * then drops the custom-property declarations nothing references any more, so the sheet
 * reads as the literal values it paints.
 *
 * Two safeties bound it. The inlining is oracle-gated: every var() a rule holds is resolved
 * over exactly the elements the rule matches, substituted only when they all agree, and the
 * whole batch is reverted if the computed-style oracle sees any render change. The deletion
 * is by construction, not oracle-gated, because getComputedStyle enumerates a custom
 * property, so removing its declaration changes that property's own computed value even
 * though nothing paints from it any more, which the oracle would wrongly veto; a name with no
 * surviving var() reference governs nothing, so dropping its declaration is render-neutral.
 *
 * A custom property is left alone, both its var() references and its declaration, when it
 * carries motion the resting frame cannot see: registered via a surviving `@property`, named
 * inside an @keyframes, listed in a transition or animation, or redefined by a state or
 * pseudo rule. That last case matters most: a resting `color: var(--x)` is dynamic, so if a
 * :hover rule redefines `--x` the color follows it on hover; inlining the resting reference
 * to its resting sample would freeze the color and strip the state change.
 */
import type { Captured } from '../types';
import { createRenderOracle, type RenderOracle } from './oracle';
import { inScopeRule, parseSegments, serializeRules, WITHHELD } from './declarations';

/**
 * Resolves `var()` references to their per-site values and drops the custom-property
 * declarations left unreferenced. Graceful by contract: returns the input unchanged on any
 * infrastructure failure, and reverts the inlining alone if it is not render-neutral while
 * still dropping the dead declarations. Deterministic: rules and declarations are processed
 * in document order.
 *
 * @param css - the stylesheet after the at-rule purge
 * @param captured - source of the viewport size; warnings are appended here on skip
 * @param markup - the emitted root markup the stylesheet targets, mounted in the oracle
 * @returns the stylesheet with var() inlined and dead custom properties removed
 */
export async function inlineVars(css: string, captured: Captured, markup: string): Promise<string> {
	if (!css.trim() || !markup.trim() || !css.includes('var(')) return css;
	let oracle: RenderOracle;
	try {
		oracle = await createRenderOracle(captured, css, markup);
	} catch (err) {
		captured.warnings.push(`minimize: var inline skipped (${(err as Error).message})`);
		return css;
	}
	try {
		oracle.captureReference();
		const held = motionHeldNames(css);
		addStateRedefinedNames(oracle.sheet, held);

		// Inline every rule's var() references, then verify the whole batch against the render.
		// A wrong substitution, or a value that varied across a rule's elements and slipped
		// through, changes a computed longhand, so revert all inlining and keep the input rules.
		const inScope = Array.from(oracle.sheet.cssRules).map(inScopeRule).filter((r): r is CSSStyleRule => r !== null);
		const saved = inScope.map((r) => r.style.cssText);
		for (const rule of inScope) inlineRule(oracle, rule, held);
		if (!oracle.matchesReference()) inScope.forEach((r, i) => (r.style.cssText = saved[i]!));

		// Drop custom-property declarations no longer referenced by any surviving var() and not
		// held for motion. By construction, not oracle-gated: an unreferenced custom property
		// paints nothing, so removing its declaration is render-neutral even though the oracle,
		// which enumerates custom-property computed values, would read the change as one.
		dropDeadCustomProps(oracle.sheet, inScope, held);
		return serializeRules(Array.from(oracle.sheet.cssRules));
	} catch (err) {
		captured.warnings.push(`minimize: var inline skipped (${(err as Error).message})`);
		return css;
	} finally {
		oracle.dispose();
	}
}

/**
 * The custom-property names that must not be inlined or dropped because their value carries
 * motion the resting frame cannot sample: a name registered by a surviving `@property`, a
 * name written inside an @keyframes block, or a name listed in a transition/animation value.
 */
function motionHeldNames(css: string): Set<string> {
	const held = new Set<string>();
	for (const m of css.matchAll(/@property\s+(--[\w-]+)/g)) held.add(m[1]!);
	for (const block of css.matchAll(/@keyframes[^{]*\{((?:[^{}]|\{[^{}]*\})*)\}/g)) {
		for (const m of block[1]!.matchAll(/(--[\w-]+)/g)) held.add(m[1]!);
	}
	// A custom property named in a transition or animation shorthand or longhand is animated.
	for (const m of css.matchAll(/(?:transition|transition-property|animation|animation-name)\s*:[^;}]*/g)) {
		for (const t of m[0].matchAll(/(--[\w-]+)/g)) held.add(t[1]!);
	}
	return held;
}

/**
 * Adds to `held` every custom property a withheld state or pseudo rule declares. Such a
 * property changes value with the interactive state, so a resting rule that reads it through
 * var() is dynamic: inlining that reference to the resting value would freeze it and drop the
 * state change the withheld rule reproduces.
 *
 * @param sheet - the mounted stylesheet
 * @param held - the motion-held name set, extended in place
 */
function addStateRedefinedNames(sheet: CSSStyleSheet, held: Set<string>): void {
	for (const rule of Array.from(sheet.cssRules)) {
		if (rule.type !== CSSRule.STYLE_RULE) continue;
		const styleRule = rule as CSSStyleRule;
		if (!WITHHELD.test(styleRule.selectorText || '')) continue;
		for (const seg of parseSegments(styleRule.style.cssText)) if (seg.prop.startsWith('--')) held.add(seg.prop);
	}
}

/**
 * Inlines one rule's var() references in place. For each declaration, each `var(--x)` whose
 * name is not motion-held is resolved to the value `--x` holds on every element the rule
 * matches; when they all agree on a non-empty value it is substituted, otherwise the
 * reference is left as written.
 */
function inlineRule(oracle: RenderOracle, rule: CSSStyleRule, held: Set<string>): void {
	if (!rule.style.cssText.includes('var(')) return;
	let elements: Element[];
	try {
		elements = Array.from(oracle.body.querySelectorAll(rule.selectorText));
	} catch {
		return;
	}
	if (elements.length === 0) return;
	const win = oracle.win;
	const resolve = (name: string): string | null => {
		if (held.has(name)) return null;
		let value: string | null = null;
		for (const el of elements) {
			const v = win.getComputedStyle(el).getPropertyValue(name).trim();
			if (!v) return null; // Unset here (a fallback would apply); leave the reference.
			if (value === null) value = v;
			else if (value !== v) return null; // Differs across the rule's elements; not one value.
		}
		return value;
	};
	const rebuilt = parseSegments(rule.style.cssText)
		.map((seg) => `${seg.prop}: ${substituteVars(seg.value, resolve)}`)
		.join('; ');
	rule.style.cssText = rebuilt;
}

/**
 * Substitutes the resolvable `var()` references in a declaration value. Walks the text,
 * matching each `var(` to its closing paren so a nested fallback or calc() is spanned whole,
 * and replaces the reference with `resolve(name)` when that returns a value, else leaves it.
 * Nested var() inside a kept reference's fallback is handled by re-walking the remainder.
 *
 * @param value - a declaration value, priority included
 * @param resolve - maps a custom-property name to its site value, or null to leave the ref
 */
function substituteVars(value: string, resolve: (name: string) => string | null): string {
	let out = '';
	let i = 0;
	while (i < value.length) {
		const start = value.indexOf('var(', i);
		if (start === -1) {
			out += value.slice(i);
			break;
		}
		out += value.slice(i, start);
		const end = matchParen(value, start + 3);
		if (end === -1) {
			out += value.slice(start);
			break;
		}
		const inner = value.slice(start + 4, end); // Between var( and )
		const comma = topLevelComma(inner);
		const name = (comma === -1 ? inner : inner.slice(0, comma)).trim();
		const resolved = /^--[\w-]+$/.test(name) ? resolve(name) : null;
		if (resolved !== null) {
			out += resolved;
			i = end + 1;
		} else {
			// Keep this reference verbatim, but still resolve any var() nested in its fallback.
			out += `var(${substituteVars(inner, resolve)})`;
			i = end + 1;
		}
	}
	return out;
}

/** The index of the paren that closes the `(` at `open`, or -1 when unbalanced. */
function matchParen(text: string, open: number): number {
	let depth = 0;
	for (let i = open; i < text.length; i++) {
		if (text[i] === '(') depth++;
		else if (text[i] === ')' && --depth === 0) return i;
	}
	return -1;
}

/** The index of the first top-level comma in a var()'s inner text, or -1 when there is none. */
function topLevelComma(inner: string): number {
	let depth = 0;
	for (let i = 0; i < inner.length; i++) {
		const ch = inner[i];
		if (ch === '(') depth++;
		else if (ch === ')') depth--;
		else if (ch === ',' && depth === 0) return i;
	}
	return -1;
}

/**
 * Removes every custom-property declaration from the in-scope rules whose name no longer
 * occurs in a `var()` anywhere in the sheet and is not motion-held. A name still read by a
 * var() in any rule, resting, withheld, or a fallback, is kept, since its declaration is
 * load-bearing. Removal is on the cssom, so a value carrying a `;` inside a url() or function
 * is handled by the parser rather than a text split.
 *
 * @param sheet - the mounted stylesheet, mutated in place
 * @param inScope - the in-scope style rules to remove dead declarations from
 * @param held - names withheld for motion, always kept
 */
function dropDeadCustomProps(sheet: CSSStyleSheet, inScope: CSSStyleRule[], held: Set<string>): void {
	const referenced = new Set<string>();
	for (const m of serializeRules(Array.from(sheet.cssRules)).matchAll(/var\(\s*(--[\w-]+)/g)) referenced.add(m[1]!);
	for (const rule of inScope) {
		for (const seg of parseSegments(rule.style.cssText)) {
			if (seg.prop.startsWith('--') && !referenced.has(seg.prop) && !held.has(seg.prop)) rule.style.removeProperty(seg.prop);
		}
	}
}
