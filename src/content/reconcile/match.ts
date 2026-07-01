/**
 * reconcile/match.ts: rule-to-element matching, the authored cascade
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
 * the matching rules via the browser's own element.matches(), orders them by
 * specificity, and merges their declarations into one authored value per
 * property. bake.ts then asks, per property, whether that authored value round-
 * trips to the computed value.
 *
 * Deliberately small, about 150 lines: no specificity edge-case handling, no
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
		// Inline style attribute wins over any stylesheet rule, equivalent to
		// specificity 1,0,0,0; fold it in last at the highest rank.
		foldInlineStyle(el, ranked, order++);
		result.set(el, resolveWinners(ranked));
	}
	return result;
}

/**
 * Pairs each live original element with its clone counterpart, tolerant of nodes
 * that feature handlers inject into the clone, such as a pseudo <style> or an icons
 * sprite <svg>. Without this, index-based pairing drifts the moment any handler
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
 * handlers for tables, lists, forms, and text micro-features. Pairs each live element
 * with its clone, reads the live computed value, and bakes the non-default ones
 * onto the clone, both inline and bakedStyles, skipping any already baked by the
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

/**
 * The fallback context for the redundancy test: the values a declaration would
 * resolve to if dropped, plus whether the element establishes a transform.
 */
export interface RedundancyContext {
	/** The value a NON-inherited property falls back to with no declaration: the
	 * per-tag ua default for denoise, or the css initial value for a pseudo-element.
	 * Undefined when no baseline is available, which keeps the declaration. */
	defaultValue: string | undefined;
	/** The value an INHERITED property falls back to with no declaration: the
	 * immediate parent's computed value for denoise, or the originating element's
	 * computed value for a pseudo-element. Undefined when none, which keeps it. */
	inheritedValue: string | undefined;
	/** Whether this property inherits by default; see inheritsProperty. */
	inherits: boolean;
	/** Whether the element establishes a transform (transform/translate/rotate/scale). */
	hasTransform: boolean;
	/** Whether the element establishes perspective. */
	hasPerspective: boolean;
}

/**
 * Pure test for a declaration that can be dropped without changing rendering: it
 * either has no effect in this context, such as an inert transition or an orphan
 * transform-origin, or it merely restates the value the element falls back to anyway,
 * the ua default for a non-inherited property or the inherited value for an inherited one.
 *
 * Every drop is render-identical by construction, so the caller can remove the
 * declaration with zero pixel change. The match is exact-string against a value the
 * caller resolved from ground truth, so an unrecognized form is kept, never guessed.
 * This is the same "validate against ground truth, never heuristics" stance bake.ts
 * takes; here it decides removal instead of baking.
 *
 * @param prop - the property name, a longhand or a shorthand we special-case
 * @param value - the declared value under test
 * @param ctx - the fallback values and transform context for this element
 * @returns true when the declaration is safe to drop
 */
export function isRedundantDecl(prop: string, value: string, ctx: RedundancyContext): boolean {
	const v = value.trim();
	// Custom properties never enumerate in getComputedStyle and carry author intent.
	if (prop.startsWith('--')) return false;
	// An empty value does not serialize anyway, so keep it: removing it would mean
	// calling removeProperty on the name, and for a shorthand, above all the `all`
	// reset, that cascades to every longhand and wipes the element's whole inline style.
	if (v === '') return false;
	// A transition acts only on a state change, never at rest, so a zeroed one is
	// pure noise. Real durations stay so a polish-added :hover still animates.
	if (prop === 'transition') return isInertTransition(v);
	if (prop.startsWith('transition-')) return false;
	// transform-origin/perspective-origin resolve to per-element pixels, so a probe
	// default is not comparable, and act only on a box that has a transform or
	// perspective. Without one they render identically whether present or not.
	if (prop === 'transform-origin') return !ctx.hasTransform;
	if (prop === 'perspective-origin') return !ctx.hasTransform && !ctx.hasPerspective;
	// Layout/used-value properties resolve to per-element pixels; a probe value is a
	// different element's pixels, so equality is meaningless. Geometry is baked
	// deliberately, so keep it.
	if (LAYOUT_PROPS.has(prop)) return false;
	// Inherited: redundant only when it equals the value the element inherits anyway.
	// Compared against the immediate parent, never initial, so an explicit value that
	// overrides an inheriting ancestor is never mistaken for a default.
	if (ctx.inherits) return ctx.inheritedValue !== undefined && v === ctx.inheritedValue.trim();
	// Non-inherited, non-layout: redundant when it equals the property's default,
	// because dropping it falls back to exactly that default.
	return ctx.defaultValue !== undefined && v === ctx.defaultValue.trim();
}

/**
 * Reads the transform/perspective context an element or pseudo-element establishes,
 * used to decide whether transform-origin/perspective-origin have any effect.
 *
 * @param cs - the element's computed style
 * @returns whether a transform and a perspective are present
 */
export function transformContext(cs: CSSStyleDeclaration): { hasTransform: boolean; hasPerspective: boolean } {
	const present = (prop: string): boolean => {
		const value = cs.getPropertyValue(prop);
		return value !== '' && value !== 'none';
	};
	const hasTransform = present('transform') || present('translate') || present('rotate') || present('scale');
	return { hasTransform, hasPerspective: present('perspective') };
}

/**
 * Whether a property inherits by default. This is a css-spec fact, the same one
 * bake.ts reads from the engine via a probe; it is listed here because the
 * override-trap-safe redundancy test must know inheritance independent of any value,
 * which a value-based probe cannot answer when the value equals the default.
 *
 * @param prop - the property name
 */
export function inheritsProperty(prop: string): boolean {
	return INHERITED.has(prop);
}

/** True for clone nodes a feature handler injected, with no original counterpart. */
export function isInjected(el: Element): boolean {
	const tag = el.tagName.toLowerCase();
	if (tag === 'style' || tag === 'script') return true;
	// The icons sprite: a hidden zero-size svg we prepended.
	if (tag === 'svg' && el.getAttribute('aria-hidden') === 'true' && /width:\s*0/.test(el.getAttribute('style') ?? '')) {
		return true;
	}
	return false;
}

/** Depth-first list of element nodes in the subtree, root first, in document order. */
export function subtreeElements(root: Element): Element[] {
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
 * against the real ancestor chain. Excludes pseudo-element rules, which target
 * ::before/::marker rather than the element and are owned by the pseudo handler, and
 * rules gated by an @media query that does not currently apply. @container/@supports
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

/**
 * Evaluate an @media condition against the live environment. Exported so the
 * interactive-states handler gates its rules on the same frozen viewport the resting
 * cascade uses, for parity.
 *
 * @param query - the @media condition text
 */
export function mediaApplies(query: string): boolean {
	try {
		return window.matchMedia(query).matches;
	} catch {
		return true; // Unparseable query: do not exclude, probe still guards bake
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

/** Flatten the ranked map to plain prop->value winners. */
function resolveWinners(ranked: Map<string, RankedDecl>): Map<string, string> {
	const out = new Map<string, string>();
	for (const [prop, decl] of ranked) out.set(prop, decl.value);
	return out;
}

/** A transition with no duration (or none/all) animates nothing and is inert at rest. */
function isInertTransition(value: string): boolean {
	return value === 'none' || value === 'all' || /^all 0s\b/.test(value) || /^0s\b/.test(value);
}

/**
 * Properties whose computed value is a per-element used value, resolved pixels,
 * which can never be compared against a probe default. Geometry is baked
 * deliberately by bake.ts, so it is kept rather than de-noised.
 */
const LAYOUT_PROPS = new Set([
	'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
	'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
	'top', 'right', 'bottom', 'left',
	'inset-block-start', 'inset-block-end', 'inset-inline-start', 'inset-inline-end',
]);

/**
 * Properties that inherit by default, per the css cascade specs: CSS2.2 plus the
 * text/font/list/table modules and their webkit aliases. Over- or under-stating
 * this set could drop a value that does not truly fall back, so it errs toward the
 * documented inherited list.
 */
const INHERITED = new Set([
	// Color and visibility
	'color', 'visibility', 'cursor', 'pointer-events', 'caret-color', 'accent-color', 'color-scheme',
	// Direction and writing mode
	'direction', 'writing-mode', 'text-orientation', 'text-combine-upright', 'unicode-bidi',
	// Fonts
	'font', 'font-family', 'font-size', 'font-size-adjust', 'font-stretch', 'font-style',
	'font-variant', 'font-variant-caps', 'font-variant-ligatures', 'font-variant-numeric',
	'font-variant-east-asian', 'font-variant-alternates', 'font-variant-position',
	'font-weight', 'font-feature-settings', 'font-kerning', 'font-language-override',
	'font-optical-sizing', 'font-synthesis', 'font-variation-settings', 'font-smooth',
	'-webkit-font-smoothing', '-webkit-locale',
	// Text layout
	'letter-spacing', 'line-height', 'text-align', 'text-align-last', 'text-indent',
	'text-justify', 'text-transform', 'text-shadow', 'text-rendering', 'text-underline-position',
	'white-space', 'white-space-collapse', 'word-break', 'word-spacing', 'word-wrap',
	'overflow-wrap', 'line-break', 'hyphens', 'hyphenate-character', 'tab-size',
	'text-size-adjust', '-webkit-text-size-adjust', 'quotes', 'orphans', 'widows',
	// Text emphasis and stroke
	'text-emphasis', 'text-emphasis-color', 'text-emphasis-style', 'text-emphasis-position',
	'-webkit-text-fill-color', '-webkit-text-stroke', '-webkit-text-stroke-color', '-webkit-text-stroke-width',
	'-webkit-tap-highlight-color',
	// Lists
	'list-style', 'list-style-image', 'list-style-position', 'list-style-type',
	// Tables
	'border-collapse', 'border-spacing', 'caption-side', 'empty-cells',
	// Rendering hints
	'image-rendering', 'print-color-adjust', '-webkit-print-color-adjust',
	// Ruby
	'ruby-align', 'ruby-position',
]);
