/**
 * reconcile/match.ts — rule-to-element matching (the authored cascade)
 *
 * Phase: c (reconcile) — see SNIPCODE-REWRITE-PLAN.md section 12
 * Pipeline position: 2 — reconcile
 * Reads from Captured: root, foundationRules, componentRules
 * Writes to Captured: nothing directly; returns the authored cascade for bake.ts
 *
 * Principles applied: supports P1 (provides the authored side of the comparison).
 *
 * Why this exists: a captured element's appearance is the sum of every rule that
 * matches it, resolved by the cascade. this module recreates that cascade from
 * the flattened CssRule[] — for each live element in the picked subtree it finds
 * the matching rules (via the browser's own element.matches()), orders them by
 * specificity, and merges their declarations into one authored value per
 * property. bake.ts then asks, per property, whether that authored value round-
 * trips to the computed value (P1).
 *
 * deliberately small (~150 lines, per section 16): no specificity edge-case
 * handling, no layer-assignment expansions, no hand-curated property Sets. the
 * probe in bake.ts validates every decision against the real computed value, so
 * a slightly-imperfect cascade here cannot produce a wrong pixel — it can only
 * fall back to computed. ported (rewritten) from v1 css-extractor.ts.
 */
import type { Captured, CssRule } from '../types';

/** one authored declaration with its cascade rank, before merge. */
interface RankedDecl {
	value: string;
	specificity: number;
	important: boolean;
	order: number; // document order, breaks specificity ties
}

/**
 * builds the merged authored cascade for every element in the picked subtree.
 *
 * @param captured — the capture; reads root + the flattened rule lists
 * @returns a map from each live element to its winning authored value per property
 */
export function authoredCascade(captured: Captured): Map<Element, Map<string, string>> {
	const rules = [...captured.foundationRules, ...captured.componentRules];
	const result = new Map<Element, Map<string, string>>();

	let order = 0;
	const all = subtreeElements(captured.root);
	for (const el of all) {
		const ranked = new Map<string, RankedDecl>();
		for (const rule of rules) {
			if (!ruleApplies(rule, el)) continue;
			mergeRule(rule, ranked, order++);
		}
		// inline style attribute wins over any stylesheet rule (specificity 1,0,0,0
		// equivalent); fold it in last at the highest rank.
		foldInlineStyle(el, ranked, order++);
		result.set(el, resolveWinners(ranked));
	}
	return result;
}

/** depth-first list of element nodes in the subtree, root first. */
function subtreeElements(root: Element): Element[] {
	const out: Element[] = [];
	const walk = (el: Element): void => {
		out.push(el);
		for (const child of Array.from(el.children)) walk(child);
	};
	walk(root);
	return out;
}

/**
 * decides whether a rule contributes to an element's authored cascade.
 *
 * uses the browser's live matcher so descendant/child combinators resolve
 * against the real ancestor chain. excludes pseudo-element rules (they target
 * ::before/::marker, not the element — the pseudo handler owns those) and rules
 * gated by an @media query that does not currently apply. @container/@supports
 * are not gated here: the bake probe validates every property against the
 * captured computed value, so an over-included rule can only fall back to
 * computed, never corrupt output.
 */
function ruleApplies(rule: CssRule, el: Element): boolean {
	if (rule.selector.includes('::')) return false; // pseudo-element rule
	if (rule.mediaQuery && !mediaApplies(rule.mediaQuery)) return false;
	try {
		// a comma selector matches if any branch matches this element.
		return el.matches(rule.selector);
	} catch {
		// :hover, :has() with unsupported args, malformed selectors — skip safely.
		return false;
	}
}

/** evaluate an @media condition against the live environment. */
function mediaApplies(query: string): boolean {
	try {
		return window.matchMedia(query).matches;
	} catch {
		return true; // unparseable query: do not exclude (probe still guards bake)
	}
}

/** add a rule's declarations to the ranked map, keyed by property. */
function mergeRule(rule: CssRule, ranked: Map<string, RankedDecl>, order: number): void {
	for (const [prop, rawValue] of rule.properties) {
		const important = /!\s*important\s*$/i.test(rawValue);
		const value = rawValue.replace(/!\s*important\s*$/i, '').trim();
		record(ranked, prop, { value, specificity: rule.specificity, important, order });
	}
}

/** fold the element's inline style attribute in as the highest-specificity source. */
function foldInlineStyle(el: Element, ranked: Map<string, RankedDecl>, order: number): void {
	const style = (el as HTMLElement).style;
	if (!style || style.length === 0) return;
	for (let i = 0; i < style.length; i++) {
		const prop = style.item(i);
		if (!prop) continue;
		record(ranked, prop, {
			value: style.getPropertyValue(prop).trim(),
			// inline styles outrank all selector specificities.
			specificity: 1_000_000,
			important: style.getPropertyPriority(prop) === 'important',
			order,
		});
	}
}

/** keep the cascade winner for a property: !important first, then specificity, then order. */
function record(ranked: Map<string, RankedDecl>, prop: string, decl: RankedDecl): void {
	const cur = ranked.get(prop);
	if (!cur || wins(decl, cur)) ranked.set(prop, decl);
}

/** cascade ordering: !important beats normal; then higher specificity; then later order. */
function wins(a: RankedDecl, b: RankedDecl): boolean {
	if (a.important !== b.important) return a.important;
	if (a.specificity !== b.specificity) return a.specificity > b.specificity;
	return a.order >= b.order;
}

/** flatten the ranked map to plain prop→value winners. */
function resolveWinners(ranked: Map<string, RankedDecl>): Map<string, string> {
	const out = new Map<string, string>();
	for (const [prop, decl] of ranked) out.set(prop, decl.value);
	return out;
}
