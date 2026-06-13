/**
 * reconcile/match.ts: rule-to-element matching (the authored cascade)
 *
 * Pipeline position: reconcile
 * Reads from Captured: root, foundationRules, componentRules
 * Writes to Captured: nothing directly; returns the authored cascade for bake.ts
 *
 * Principles applied: provides the authored side of the per-element authored-vs-
 * computed comparison.
 *
 * Why this exists: a captured element's appearance is the sum of every rule that
 * matches it, resolved by the cascade. This module recreates that cascade from
 * the flattened CssRule[], for each live element in the picked subtree it finds
 * the matching rules (via the browser's own element.matches()), orders them by
 * specificity, and merges their declarations into one authored value per
 * property. bake.ts then asks, per property, whether that authored value round-
 * trips to the computed value.
 *
 * Deliberately small (~150 lines): no specificity edge-case handling, no
 * layer-assignment expansions, no hand-curated property Sets. The probe in
 * bake.ts validates every decision against the real computed value, so a
 * slightly-imperfect cascade here cannot produce a wrong pixel, it can only
 * fall back to computed.
 */
import type { Captured, CssRule } from '../types';

/** One authored declaration with its cascade rank, before merge. */
interface RankedDecl {
	value: string;
	specificity: number;
	important: boolean;
	order: number; // Document order, breaks specificity ties
}

/**
 * Builds the merged authored cascade for every element in the picked subtree.
 *
 * @param captured - the capture; reads root + the flattened rule lists
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
		// Inline style attribute wins over any stylesheet rule (specificity 1,0,0,0
		// equivalent); fold it in last at the highest rank.
		foldInlineStyle(el, ranked, order++);
		result.set(el, resolveWinners(ranked));
	}
	return result;
}

/**
 * Pairs each live original element with its clone counterpart, tolerant of nodes
 * that feature handlers inject into the clone (a pseudo <style>, an icons sprite
 * <svg>, etc.). Without this, index-based pairing drifts the moment any handler
 * mutates clone structure, and downstream handlers silently misalign.
 *
 * Walks both trees in lockstep, skipping injected clone-only children at each
 * level so the structural correspondence holds. Shared by every handler that
 * needs to read a live element's computed style while writing to its clone.
 *
 * @param root - the live snip root
 * @param clone - the working clone (may carry handler-injected nodes)
 * @returns aligned [original, clone] pairs, root first
 */
export function pairedSubtrees(root: Element, clone: Element): Array<[Element, Element]> {
	const out: Array<[Element, Element]> = [];
	const walk = (o: Element, c: Element): void => {
		out.push([o, c]);
		const oChildren = Array.from(o.children);
		const cChildren = Array.from(c.children).filter((ch) => !isInjected(ch));
		const n = Math.min(oChildren.length, cChildren.length);
		for (let i = 0; i < n; i++) {
			const oc = oChildren[i];
			const cc = cChildren[i];
			if (oc && cc) walk(oc, cc);
		}
	};
	walk(root, clone);
	return out;
}

/** One property a feature handler bakes when its computed value is non-default. */
export interface BakeSpec {
	prop: string;
	isDefault: (value: string) => boolean;
}

/**
 * Shared helper for the "bake these computed properties when non-default" feature
 * handlers (tables, lists, forms, text micro-features). Pairs each live element
 * with its clone, reads the live computed value, and bakes the non-default ones
 * onto the clone (inline + bakedStyles), skipping any already baked by the
 * per-element pass.
 *
 * Keeping the getComputedStyle read here, in the reconcile core, also keeps the
 * leaf handlers themselves free of it.
 *
 * @param captured - bakedStyles + clone mutated in place
 * @param specs - the properties to consider, each with its default predicate
 */
export function bakeNonDefaultProps(captured: Captured, specs: BakeSpec[]): void {
	for (const [original, clone] of pairedSubtrees(captured.root, captured.clone)) {
		const computed = getComputedStyle(original);
		const baked = captured.bakedStyles.get(clone) ?? new Map<string, string>();
		for (const { prop, isDefault } of specs) {
			if (baked.has(prop)) continue;
			const value = computed.getPropertyValue(prop);
			if (!value || isDefault(value)) continue;
			baked.set(prop, value);
			try {
				(clone as HTMLElement).style.setProperty(prop, value);
			} catch {
				// Invalid for this element; skip.
			}
		}
		if (baked.size > 0) captured.bakedStyles.set(clone, baked);
	}
}

/** True for clone nodes a feature handler injected (no original counterpart). */
function isInjected(el: Element): boolean {
	const tag = el.tagName.toLowerCase();
	if (tag === 'style' || tag === 'script') return true;
	// The icons sprite: a hidden zero-size svg we prepended.
	if (tag === 'svg' && el.getAttribute('aria-hidden') === 'true' && /width:\s*0/.test(el.getAttribute('style') ?? '')) {
		return true;
	}
	return false;
}

/** Depth-first list of element nodes in the subtree, root first. */
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
 * Decides whether a rule contributes to an element's authored cascade.
 *
 * Uses the browser's live matcher so descendant/child combinators resolve
 * against the real ancestor chain. Excludes pseudo-element rules (they target
 * ::before/::marker, not the element, the pseudo handler owns those) and rules
 * gated by an @media query that does not currently apply. @container/@supports
 * are not gated here: the bake probe validates every property against the
 * captured computed value, so an over-included rule can only fall back to
 * computed, never corrupt output.
 */
function ruleApplies(rule: CssRule, el: Element): boolean {
	if (rule.selector.includes('::')) return false; // Pseudo-element rule
	if (rule.mediaQuery && !mediaApplies(rule.mediaQuery)) return false;
	try {
		// A comma selector matches if any branch matches this element.
		return el.matches(rule.selector);
	} catch {
		// :hover, :has() with unsupported args, malformed selectors, skip safely.
		return false;
	}
}

/** Evaluate an @media condition against the live environment. */
function mediaApplies(query: string): boolean {
	try {
		return window.matchMedia(query).matches;
	} catch {
		return true; // Unparseable query: do not exclude (probe still guards bake)
	}
}

/** Add a rule's declarations to the ranked map, keyed by property. */
function mergeRule(rule: CssRule, ranked: Map<string, RankedDecl>, order: number): void {
	for (const [prop, rawValue] of rule.properties) {
		const important = /!\s*important\s*$/i.test(rawValue);
		const value = rawValue.replace(/!\s*important\s*$/i, '').trim();
		record(ranked, prop, { value, specificity: rule.specificity, important, order });
	}
}

/** Fold the element's inline style attribute in as the highest-specificity source. */
function foldInlineStyle(el: Element, ranked: Map<string, RankedDecl>, order: number): void {
	const style = (el as HTMLElement).style;
	if (!style || style.length === 0) return;
	for (let i = 0; i < style.length; i++) {
		const prop = style.item(i);
		if (!prop) continue;
		record(ranked, prop, {
			value: style.getPropertyValue(prop).trim(),
			// Inline styles outrank all selector specificities.
			specificity: 1_000_000,
			important: style.getPropertyPriority(prop) === 'important',
			order,
		});
	}
}

/** Keep the cascade winner for a property: !important first, then specificity, then order. */
function record(ranked: Map<string, RankedDecl>, prop: string, decl: RankedDecl): void {
	const cur = ranked.get(prop);
	if (!cur || wins(decl, cur)) ranked.set(prop, decl);
}

/** Cascade ordering: !important beats normal; then higher specificity; then later order. */
function wins(a: RankedDecl, b: RankedDecl): boolean {
	if (a.important !== b.important) return a.important;
	if (a.specificity !== b.specificity) return a.specificity > b.specificity;
	return a.order >= b.order;
}

/** Flatten the ranked map to plain prop→value winners. */
function resolveWinners(ranked: Map<string, RankedDecl>): Map<string, string> {
	const out = new Map<string, string>();
	for (const [prop, decl] of ranked) out.set(prop, decl.value);
	return out;
}
