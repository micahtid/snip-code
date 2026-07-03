/**
 * minimize/merge.ts: merge identical rules into selector lists
 *
 * Pipeline position: minimize, after normalize and before relax
 * Reads from Captured: page.viewport via the oracle; warnings on graceful skip
 * Writes to Captured: nothing; transforms the normalized stylesheet string
 *
 * Why this exists: the reproduce phase gives every element its own generated class and
 * rule, so a grid of eight cards styled the same emits the same declaration block eight
 * times. Pruning and normalizing can also drive two rules that differed to the identical
 * body. A human writes that body once against a selector list. This phase collapses every
 * group of rules whose declaration block is now identical into one rule whose selector is
 * the comma-joined list, in document order, and drops the duplicates.
 *
 * The merged resting rule takes the position of the last rule in its group, the latest
 * cascade position the block held, and every such merge is verified by the computed-style
 * oracle over exactly the elements the group's selectors match, so a cascade change from
 * moving a block later, past some rule that overrides one of its properties, is caught and
 * that merge is reverted while the others stand.
 *
 * The withheld state and pseudo rules are merged too, but the resting oracle is blind to
 * them, so their merge is accepted by construction under syntactic checks rather than by the
 * oracle; see mergeWithheldRules. At rules stay out of scope. The transform is deterministic,
 * groups are processed in selector order, and it only ever shrinks the stylesheet.
 */
import type { Captured } from '../types';
import { createRenderOracle, type RenderOracle } from './oracle';
import { inScopeRule, serializeRules, WITHHELD } from './declarations';

/**
 * The dynamic pseudo-classes and every pseudo-element, stripped from a withheld selector to
 * find the elements it targets. The remaining selector, its classes, attributes, and the
 * data-snip markers, matches those elements at rest, so querying it locates the render a
 * cascade reorder could touch. The dynamic-class alternatives are longest-first so
 * `:focus-visible` is consumed whole rather than leaving a `-visible` fragment.
 */
const DYNAMIC_PSEUDO = /::[\w-]+(?:\([^)]*\))?|:(?:hover|focus-visible|focus-within|focus|active|visited|link|target)(?![-\w])/gi;

/**
 * Merges rules with identical declaration blocks into selector lists. Graceful by
 * contract, returning the input unchanged on any infrastructure failure; each individual
 * merge is oracle-verified and reverted if it is not render-neutral.
 *
 * @param css - the normalized stylesheet, after normalize
 * @param captured - source of the viewport size; warnings are appended here on skip
 * @param markup - the emitted root markup the stylesheet targets, mounted in the oracle
 * @returns the merged stylesheet, or the input unchanged on any failure
 */
export async function mergeCss(css: string, captured: Captured, markup: string): Promise<string> {
	if (!css.trim() || !markup.trim()) return css;
	let oracle: RenderOracle;
	try {
		oracle = await createRenderOracle(captured, css, markup);
	} catch (err) {
		captured.warnings.push(`merge: skipped (${(err as Error).message})`);
		return css;
	}
	try {
		oracle.captureReference();
		const topRules = Array.from(oracle.sheet.cssRules);

		// Group the in-scope rules by their declaration block, keeping document order within
		// each group. An emptied rule carries no block to share, so it is skipped.
		const byBody = new Map<string, CSSStyleRule[]>();
		for (const rule of topRules) {
			const styleRule = inScopeRule(rule);
			if (!styleRule || styleRule.style.length === 0) continue;
			const body = styleRule.style.cssText;
			const group = byBody.get(body);
			if (group) group.push(styleRule);
			else byBody.set(body, [styleRule]);
		}

		// Merge each group of two or more, in selector order for determinism.
		const groups = [...byBody.values()].filter((g) => g.length >= 2);
		groups.sort((a, b) => a[0]!.selectorText.localeCompare(b[0]!.selectorText));
		for (const group of groups) mergeGroup(oracle, group);

		// Extend the merge to the withheld state and pseudo rules, which the resting oracle
		// cannot verify, under the syntactic checks in mergeWithheldRules.
		mergeWithheldRules(oracle, topRules);

		return serializeRules(topRules);
	} catch (err) {
		captured.warnings.push(`merge: skipped (${(err as Error).message})`);
		return css;
	} finally {
		oracle.dispose();
	}
}

/**
 * Merges one group of identical-body rules in place, reverting if the merge is not
 * render-neutral. The last rule keeps the block and takes the comma-joined selector; the
 * earlier rules are emptied so serialize drops them. Verification is scoped to the
 * elements the group's selectors match and their descendants, the only render a position
 * change can affect.
 *
 * @param oracle - the mounted render
 * @param group - the identical-body rules, in document order
 */
function mergeGroup(oracle: RenderOracle, group: CSSStyleRule[]): void {
	const keeper = group[group.length - 1]!;
	const savedSelector = keeper.selectorText;
	const savedBodies = group.map((r) => r.style.cssText);

	const affected = oracle.subtreeTargets(matchedElements(oracle, group));
	keeper.selectorText = group.map((r) => r.selectorText).join(', ');
	for (let i = 0; i < group.length - 1; i++) group[i]!.style.cssText = '';

	if (!oracle.matchesSubset(affected)) {
		keeper.selectorText = savedSelector;
		group.forEach((r, i) => (r.style.cssText = savedBodies[i]!));
	}
}

/** The elements any rule in the group matches, before the merge changes any selector. */
function matchedElements(oracle: RenderOracle, group: CSSStyleRule[]): Element[] {
	const seen = new Set<Element>();
	for (const rule of group) {
		try {
			for (const el of Array.from(oracle.body.querySelectorAll(rule.selectorText))) seen.add(el);
		} catch {
			// An unsupported selector matches nothing here; the subtree check still guards the rest.
		}
	}
	return [...seen];
}

/** A top-level style rule with its position and the elements it participates in styling. */
interface StyleRuleRef {
	rule: CSSStyleRule;
	pos: number;
	withheld: boolean;
	/** The elements it can style, its dynamic pseudos stripped, or null when undeterminable. */
	targets: Set<Element> | null;
}

/**
 * Merges the withheld state and pseudo rules with identical declaration blocks into selector
 * lists, keeping the first rule's position and joining the selectors in document order. The
 * resting oracle is blind to these rules, so a merge is accepted only by construction, when
 * three syntactic checks hold: the bodies are byte-identical (the grouping key); each
 * selector keeps its own specificity in a list, so joining changes none; and no rule the
 * merge reorders a group member past, resting rule or withheld rule alike, styles an element
 * that member also targets, so no element's cascade order changes. Generated per-element
 * selectors make those target sets disjoint, so the third check passes and the group
 * collapses; a group that fails it is left as written.
 *
 * @param oracle - the mounted render, used only to resolve which elements a selector targets
 * @param topRules - the frame stylesheet's top-level rules, mutated in place
 */
function mergeWithheldRules(oracle: RenderOracle, topRules: CSSRule[]): void {
	// Every top-level style rule, resting and withheld, with the elements it can style, so a
	// group's merge is checked against every rule it would reorder past rather than assuming
	// the withheld rules form one contiguous block.
	const styleRules: StyleRuleRef[] = [];
	for (let pos = 0; pos < topRules.length; pos++) {
		const rule = topRules[pos]!;
		if (rule.type !== CSSRule.STYLE_RULE) continue;
		const styleRule = rule as CSSStyleRule;
		if (styleRule.style.length === 0) continue;
		const withheld = WITHHELD.test(styleRule.selectorText || '');
		styleRules.push({ rule: styleRule, pos, withheld, targets: ruleTargets(oracle, styleRule.selectorText, withheld) });
	}

	// Group the withheld rules by declaration block, document order preserved within each group.
	const byBody = new Map<string, StyleRuleRef[]>();
	for (const ref of styleRules) {
		if (!ref.withheld) continue;
		const group = byBody.get(ref.rule.style.cssText);
		if (group) group.push(ref);
		else byBody.set(ref.rule.style.cssText, [ref]);
	}

	const groups = [...byBody.values()].filter((g) => g.length >= 2);
	groups.sort((a, b) => a[0]!.rule.selectorText.localeCompare(b[0]!.rule.selectorText));
	for (const group of groups) {
		if (!safeToMergeWithheld(group, styleRules)) continue;
		const keeper = group[0]!.rule;
		keeper.selectorText = group.map((w) => w.rule.selectorText).join(', ');
		for (let i = 1; i < group.length; i++) group[i]!.rule.style.cssText = ''; // Dropped by serialize.
	}
}

/**
 * Whether merging a withheld group is render-neutral. The group's selectors collapse onto the
 * first member's position, so every later member's rule moves earlier, past the rules between
 * its old position and the first. The move is safe when none of those intervening rules
 * targets an element the moving member also targets: with disjoint targets, reordering the two
 * changes no element's cascade. An undeterminable target set (an unusual selector) is treated
 * as overlapping, so the group is conservatively left unmerged.
 *
 * @param group - the identical-body withheld rules, in document order
 * @param styleRules - every top-level style rule, to scan the positions the group spans
 */
function safeToMergeWithheld(group: StyleRuleRef[], styleRules: StyleRuleRef[]): boolean {
	const first = group[0]!.pos;
	const groupPositions = new Set(group.map((w) => w.pos));
	for (const other of styleRules) {
		if (other.pos <= first || groupPositions.has(other.pos)) continue;
		// `other` sits after the keeper; a group member moves past it only if that member's old
		// position is later than `other`. Any such member with an overlapping target set makes
		// the reorder observable.
		for (const member of group) {
			if (member.pos <= other.pos) continue;
			if (!member.targets || !other.targets || intersects(member.targets, other.targets)) return false;
		}
	}
	return true;
}

/**
 * The elements a rule can style: a resting rule matches its selector directly, a withheld rule
 * matches with its dynamic pseudos and pseudo-elements stripped, so the state or pseudo box's
 * host element is found. Null when the remaining selector is empty or will not parse.
 */
function ruleTargets(oracle: RenderOracle, selector: string, withheld: boolean): Set<Element> | null {
	const base = withheld ? selector.replace(DYNAMIC_PSEUDO, '').trim() : selector;
	if (!base) return null;
	try {
		return new Set(Array.from(oracle.body.querySelectorAll(base)));
	} catch {
		return null;
	}
}

/** Whether two element sets share a member. */
function intersects(a: Set<Element>, b: Set<Element>): boolean {
	const [small, large] = a.size <= b.size ? [a, b] : [b, a];
	for (const el of small) if (large.has(el)) return true;
	return false;
}
