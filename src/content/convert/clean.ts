/**
 * convert/clean.ts: dead-code elimination
 *
 * Pipeline position: convert
 * Reads from Captured: clone (to test selector/usage)
 * Writes to Captured: nothing (operates on the emitted css string)
 *
 * Cleanup is dead-code elimination, not aesthetic surgery.
 *
 * Why this exists: the emitted stylesheet can carry rules and at-rules that
 * nothing in the snip references. This removes EXACTLY four kinds of dead code and
 * nothing else:
 * 1. Style rules whose selector matches no element in the snip
 * 2. Css custom properties that nothing references
 * 3. @font-face whose family is never used
 * 4. @keyframes whose name is never referenced by an animation
 *
 * this is the antithesis of v1's 2,477-line cleaner.ts: no hand-curated property
 * Sets, no is<X> predicates, no "shading-critical" / "vertical text spacing"
 * heuristics. Usage is measured against ground truth, the
 * actual clone subtree and the actual declarations, so the cleaner can never
 * remove something the output depends on. It is reused by every format emitter
 * (html inline, bem/tailwind/scss class rules), so it must be format-agnostic.
 */
import type { Captured } from '../types';

const VAR_REF = /var\(\s*(--[A-Za-z0-9_-]+)/g;
/** keepRule returns this to signal "drop this rule". */
const DROP = '';

/**
 * Removes dead code from an emitted stylesheet.
 *
 * @param css - the stylesheet text to prune
 * @param captured - the snip; usage is measured against captured.clone + the css
 * @returns the cleaned stylesheet text
 */
export function cleanCss(css: string, captured: Captured): string {
	if (!css.trim()) return css;
	const sheet = new CSSStyleSheet();
	try {
		sheet.replaceSync(css);
	} catch {
		// Unparseable css (rare): return as-is rather than risk dropping content.
		return css;
	}

	const usage = collectUsage(captured, css);
	const kept: string[] = [];
	for (const rule of Array.from(sheet.cssRules)) {
		const text = keepRule(rule, captured, usage);
		if (text) kept.push(text);
	}
	return kept.join('\n\n');
}

/** What the snip actually references, gathered from the clone + the css itself. */
interface Usage {
	families: Set<string>; // Lowercased font-family names in use
	animations: Set<string>; // Animation-name tokens in use
	vars: Set<string>; // --names referenced by var()
}

/**
 * Decides whether a single top-level rule survives. Returns its serialized text
 * to keep, or '' to drop. Recurses into grouping rules (@media/@supports) and
 * drops them if they end up empty.
 */
function keepRule(rule: CSSRule, captured: Captured, usage: Usage): string {
	if (rule instanceof CSSStyleRule) {
		// Keep custom-property-only :root rules pruned to referenced vars;
		// keep element rules only if some clone element matches them.
		if (isRootVarRule(rule)) return pruneVarRule(rule, usage);
		return selectorMatchesSubtree(rule.selectorText, captured.clone) ? rule.cssText : DROP;
	}
	if (rule instanceof CSSFontFaceRule) {
		const family = (rule.style.getPropertyValue('font-family') || '').replace(/^["']|["']$/g, '').toLowerCase();
		return usage.families.has(family) ? rule.cssText : DROP; // An unused @font-face family
	}
	if (rule instanceof CSSKeyframesRule) {
		return usage.animations.has(rule.name) ? rule.cssText : DROP; // An unreferenced @keyframes
	}
	if (rule instanceof CSSMediaRule || rule instanceof CSSSupportsRule) {
		// Recurse; keep the wrapper only if it still has live inner rules.
		const inner: string[] = [];
		for (const child of Array.from(rule.cssRules)) {
			const text = keepRule(child, captured, usage);
			if (text) inner.push(text);
		}
		if (inner.length === 0) return DROP;
		const cond = rule instanceof CSSMediaRule ? `@media ${rule.conditionText}` : `@supports ${rule.conditionText}`;
		return `${cond} {\n${inner.join('\n')}\n}`;
	}
	// Unknown rule type (e.g. @layer/@property): keep verbatim, do not guess.
	return rule.cssText;
}

/** True when a selector matches the snip root or any descendant. */
function selectorMatchesSubtree(selector: string, root: Element): boolean {
	for (const branch of selector.split(',')) {
		const s = branch.trim();
		if (!s) continue;
		try {
			if (root.matches(s) || root.querySelector(s)) return true;
		} catch {
			// Unsupported selector (e.g. ::selection pseudo): keep it, do not drop
			// something we cannot evaluate.
			return true;
		}
	}
	return false;
}

/** A :root / html rule that only defines custom properties. */
function isRootVarRule(rule: CSSStyleRule): boolean {
	if (!/(^|,)\s*(:root|html)\s*(,|$)/.test(rule.selectorText)) return false;
	for (let i = 0; i < rule.style.length; i++) {
		const prop = rule.style.item(i);
		if (prop && !prop.startsWith('--')) return false;
	}
	return true;
}

/** Drop unreferenced custom properties from a :root var rule. */
function pruneVarRule(rule: CSSStyleRule, usage: Usage): string {
	const kept: string[] = [];
	for (let i = 0; i < rule.style.length; i++) {
		const prop = rule.style.item(i);
		if (!prop) continue;
		if (usage.vars.has(prop)) kept.push(`\t${prop}: ${rule.style.getPropertyValue(prop)};`);
	}
	if (kept.length === 0) return DROP;
	return `${rule.selectorText} {\n${kept.join('\n')}\n}`;
}

/**
 * Gathers all font-family, animation-name, and var() usage from both the clone
 * subtree (inline styles) and the css text (class-based rules), so the cleaner
 * works for inline html and class-based formats alike.
 */
function collectUsage(captured: Captured, css: string): Usage {
	const families = new Set<string>();
	const animations = new Set<string>();
	const vars = new Set<string>();

	// From the clone subtree's inline styles.
	for (const [, baked] of captured.bakedStyles) {
		addFamilies(baked.get('font-family'), families);
		addFamilies(baked.get('font'), families);
		addAnimations(baked.get('animation'), animations);
		addAnimations(baked.get('animation-name'), animations);
		for (const value of baked.values()) addVars(value, vars);
	}
	// From the css text (covers class-based rules and any @media bodies).
	addFamilies(matchAll(css, /font-family\s*:\s*([^;}{]+)/gi), families);
	addAnimations(matchAll(css, /animation(?:-name)?\s*:\s*([^;}{]+)/gi), animations);
	addVars(css, vars);

	return { families, animations, vars };
}

/** Split a font-family value list into lowercased family names. */
function addFamilies(value: string | string[] | undefined, into: Set<string>): void {
	if (!value) return;
	const values = Array.isArray(value) ? value : [value];
	for (const v of values) {
		for (const token of v.split(',')) {
			const name = token.replace(/^["']|["']$/g, '').trim().toLowerCase();
			if (name) into.add(name);
		}
	}
}

/** Collect animation-name tokens (a name can never collide with a duration token). */
function addAnimations(value: string | string[] | undefined, into: Set<string>): void {
	if (!value) return;
	const values = Array.isArray(value) ? value : [value];
	for (const v of values) {
		for (const part of v.split(',')) {
			for (const token of part.trim().split(/\s+/)) {
				const t = token.trim();
				if (t) into.add(t);
			}
		}
	}
}

/** Collect --names referenced by var() in a string. */
function addVars(value: string | undefined, into: Set<string>): void {
	if (!value) return;
	let m: RegExpExecArray | null;
	VAR_REF.lastIndex = 0;
	while ((m = VAR_REF.exec(value)) !== null) {
		if (m[1]) into.add(m[1]);
	}
}

/** Run a capture-group regex over text and return all group-1 matches. */
function matchAll(text: string, re: RegExp): string[] {
	const out: string[] = [];
	let m: RegExpExecArray | null;
	re.lastIndex = 0;
	while ((m = re.exec(text)) !== null) {
		if (m[1]) out.push(m[1]);
	}
	return out;
}
