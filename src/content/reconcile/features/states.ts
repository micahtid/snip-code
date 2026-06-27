/**
 * features/states.ts: interactive-state rules (:hover, :focus, :active)
 *
 * Pipeline position: reconcile
 * Reads from Captured: root, clone, foundationRules, componentRules, bakedStyles
 * Writes to Captured: clone (marks elements + appends a <style> of state rules), warnings
 *
 * Extends the "ship what renders" approach to the interactive states a static
 * snapshot drops: a button that lightens on hover, a link that underlines, an input
 * that rings on focus. These are plain css rules the page already captured, but the
 * resting cascade discards them because the element is not being hovered/focused at
 * capture time (el.matches('.btn:hover') is false at rest), flattening each property
 * to a single resting value. This handler reads those state rules back out and emits
 * them so they reproduce in the standalone artifact.
 *
 * CSS/spec reference: https://developer.mozilla.org/en-US/docs/Web/CSS/:hover (and
 * :focus / :focus-visible / :focus-within / :active). The trigger set is the closed
 * spec category of dynamic interactive pseudo-classes; the form-state pseudos
 * (:checked, :disabled, …) are excluded because they reflect current dom state and are
 * already captured at rest.
 *
 * Why this exists / four things a naive re-emit gets wrong:
 *  - A resting value ships as an inline style attribute, and a normal inline
 *    declaration outranks every normal selector (it is resolved before specificity is
 *    consulted). So a state rule in a <style> block has zero effect unless it is
 *    !important — the same reason the email inliner juice keeps :hover in a surviving
 *    <style> rather than inlining it. State declarations are therefore emitted
 *    !important; because the state selector matches only while the state is active, the
 *    override applies only during interaction and reverts cleanly to the inline base at
 *    rest.
 *  - A captured selector (`body.dark .nav > .btn:hover`) is written against the live
 *    page's classes and ancestor chain, which the emitters rewrite and the standalone
 *    artifact does not carry. Each state-bearing and subject element is re-anchored to a
 *    unique data-snip-state marker (a data-* attribute, so it survives the tailwind/bem
 *    emitters that rewrite class). A purely-structural ancestor compound (`body.dark`) is
 *    only a gate — "does this apply right now?" — already resolved against the live
 *    element at capture, exactly as a matched @media is frozen-satisfied, so it is
 *    dropped, not reproduced.
 *  - The one irreducible boundary: a state whose trigger element is outside the snipped
 *    subtree (`.outside:hover .snipped`) cannot be reproduced — the artifact does not
 *    contain the thing to hover. That declaration is dropped with a warning, never a
 *    silent or wrong result.
 *
 * Transform contract: tags each bound, in-subtree element with a data-snip-state marker
 * and adds `[data-snip-state="n"]:hover {…}` rules to the clone's shared synthesized
 * <style> (see reconcile/synthesized.ts), with declarations resolved as the state cascade
 * per property, denoised against the resting baseline, and emitted !important. Clone only;
 * state selectors match nothing at rest, so the resting render is byte-identical.
 * Test fixtures: tests/fixtures/state-{card,form,var,localvar,url,pseudo}.html, registered
 * in tests/fixtures.mjs; the gate measures the resting (state-inactive) render.
 */
import type { Captured, CssRule } from '../../types';
import { pairedSubtrees, mediaApplies } from '../match';
import { appendSynthesizedRules } from '../synthesized';
import {
	parseSelectorList,
	containsDynamicPseudo,
	type Complex,
	type Compound,
	type Combinator,
} from '../selector';

const MARKER = 'data-snip-state';

/** One compound that earns a marker in the output: the subject, or any state-bearing compound. */
interface MarkedCompound {
	/** The live element this compound binds to. */
	element: Element;
	/** The dynamic interactive pseudo-classes to keep on this compound, e.g. `[':hover']`. */
	dynamicPseudos: string[];
	/** The pseudo-element to keep on this compound (`::after`), or '' if none. */
	pseudoElement: string;
}

/** One rule branch successfully bound to concrete subtree elements, ready to re-anchor. */
interface Candidate {
	/** The marked compounds, left-to-right; the last is the subject (declarations land there). */
	marked: MarkedCompound[];
	/** The combinator between each pair of marked compounds (length marked.length - 1). */
	combinators: Combinator[];
	/** The rule whose declarations this branch contributes. */
	rule: CssRule;
	/** The rule's position in capture order, breaking cascade ties. */
	order: number;
}

/** One authored state declaration with its cascade rank, before the per-property merge. */
interface RankedStateDecl {
	value: string;
	important: boolean;
	specificity: number;
	order: number;
}

/**
 * Reproduces the page's interactive-state rules on the clone.
 *
 * @param captured - clone is mutated in place (markers + an appended <style>)
 */
export function apply(captured: Captured): Captured {
	const pairs = pairedSubtrees(captured.root, captured.clone);
	const originalToClone = new Map<Element, Element>(pairs.map(([original, clone]) => [original, clone]));

	const candidates = collectCandidates(captured, pairs, originalToClone);
	if (candidates.length === 0) return captured;

	// Number every marked element by document order, so the markers and the rules they
	// key are deterministic regardless of the order rules were discovered in.
	const markerIds = assignMarkers(pairs, candidates);
	for (const [el, id] of markerIds) {
		const clone = originalToClone.get(el);
		if (clone) clone.setAttribute(MARKER, String(id));
	}

	// Group candidates by the selector they re-anchor to: candidates that target the same
	// elements in the same state share an output rule, and their declarations merge by the
	// cascade. Building the selector also catches an inexpressible marker relationship.
	const groups = new Map<string, { subjectClone: Element; winners: Map<string, RankedStateDecl> }>();
	for (const cand of candidates) {
		const selector = buildSelector(cand, markerIds);
		if (!selector) {
			captured.warnings.push(`states: could not re-anchor "${cand.rule.selector}" standalone; effect dropped`);
			continue;
		}
		const subject = cand.marked[cand.marked.length - 1];
		if (!subject) continue;
		const subjectClone = originalToClone.get(subject.element);
		if (!subjectClone) continue;
		const group = groups.get(selector) ?? { subjectClone, winners: new Map<string, RankedStateDecl>() };
		mergeRule(cand.rule, cand.order, group.winners);
		groups.set(selector, group);
	}

	const rules: string[] = [];
	for (const [selector, { subjectClone, winners }] of groups) {
		const decls = denoise(winners, captured.bakedStyles.get(subjectClone));
		if (decls.length > 0) rules.push(`${selector} {\n${decls.join('\n')}\n}`);
	}

	appendSynthesizedRules(captured, rules);
	return captured;
}

/**
 * Discovers the interactive-state rules and binds each to concrete subtree elements.
 * A rule is considered when its selector mentions a dynamic interactive pseudo-class and
 * its @media gate currently applies (the same frozen viewport the resting cascade uses).
 *
 * @param captured - the capture; reads the flattened rule lists + root subtree
 * @param pairs - the [original, clone] subtree pairs, in document order
 * @param originalToClone - membership test + clone lookup for the subtree
 * @returns one candidate per (rule branch, subject element) that bound entirely in-subtree
 */
function collectCandidates(
	captured: Captured,
	pairs: Array<[Element, Element]>,
	originalToClone: Map<Element, Element>,
): Candidate[] {
	const subtree = pairs.map(([original]) => original);
	const inSubtree = (el: Element | null): el is Element => el !== null && originalToClone.has(el);
	const candidates: Candidate[] = [];
	const unreproducible = new Set<string>(); // Selectors already warned, so a multi-match rule warns once.
	let order = 0;

	for (const rule of [...captured.foundationRules, ...captured.componentRules]) {
		if (!containsDynamicPseudo(rule.selector)) continue;
		if (rule.mediaQuery && !mediaApplies(rule.mediaQuery)) continue;
		const thisOrder = order++;

		let branches: Complex[];
		try {
			branches = parseSelectorList(rule.selector);
		} catch {
			captured.warnings.push(`states: unparseable selector "${rule.selector}"; effect dropped`);
			continue;
		}

		for (const branch of branches) {
			if (!branch.compounds.some((c) => c.dynamicPseudos.length > 0)) continue;
			const structural = structuralSelector(branch);
			for (const subjectEl of subtree) {
				if (!safeMatches(subjectEl, structural)) continue;
				const marked = bindMarkedCompounds(branch, subjectEl, inSubtree);
				if (!marked) {
					// The trigger binds outside the subtree, or the selector relationship cannot
					// be re-anchored to markers standalone. Either way the effect is dropped.
					if (!unreproducible.has(rule.selector)) {
						unreproducible.add(rule.selector);
						captured.warnings.push(`states: could not reproduce "${rule.selector}" standalone (trigger outside the snip or unsupported relationship); effect dropped`);
					}
					continue;
				}
				candidates.push({ marked: marked.marked, combinators: marked.combinators, rule, order: thisOrder });
			}
		}
	}
	return candidates;
}

/**
 * Binds every marked compound of a branch (the subject, plus each compound carrying a
 * dynamic pseudo) to a concrete element, walking the combinator chain leftward from the
 * subject. Structural-only intermediate compounds are gates: bound only as stepping
 * stones, never marked.
 *
 * @param branch - the parsed complex selector
 * @param subjectEl - the element matched by the branch's full structural selector
 * @param inSubtree - whether an element belongs to the snipped subtree
 * @returns the marked compounds + their combinators, or null if a state-bearing compound
 *   bound outside the subtree (the irreducible boundary) or could not be bound at all
 */
function bindMarkedCompounds(
	branch: Complex,
	subjectEl: Element,
	inSubtree: (el: Element | null) => el is Element,
): { marked: MarkedCompound[]; combinators: Combinator[] } | null {
	const n = branch.compounds.length;
	const bound: Array<Element | null> = new Array(n).fill(null);
	bound[n - 1] = subjectEl;
	for (let k = n - 2; k >= 0; k--) {
		const right = bound[k + 1];
		const compound = branch.compounds[k];
		const combinator = branch.combinators[k];
		if (!right || !compound || !combinator) return null;
		bound[k] = findRelated(right, combinator, compound);
	}

	const marked: MarkedCompound[] = [];
	const combinators: Combinator[] = [];
	for (let k = 0; k < n; k++) {
		const compound = branch.compounds[k];
		if (!compound) return null;
		const isSubject = k === n - 1;
		const isStateBearing = compound.dynamicPseudos.length > 0;
		if (!isSubject && !isStateBearing) continue; // A purely-structural gate: dropped.
		const el = bound[k] ?? null;
		// A state-bearing compound must bind inside the subtree; otherwise its trigger is
		// not present in the artifact and the effect cannot be reproduced.
		if (!inSubtree(el)) return null;
		if (marked.length > 0) {
			const combinator = generalize(marked[marked.length - 1]!.element, el);
			if (!combinator) return null;
			combinators.push(combinator);
		}
		marked.push({ element: el, dynamicPseudos: compound.dynamicPseudos, pseudoElement: compound.pseudoElement });
	}
	return { marked, combinators };
}

/**
 * Resolves the element a compound binds to, given the element bound to the compound on
 * its right and the combinator between them. Takes the nearest match for the loose
 * relations (descendant, subsequent-sibling), which the unique marker then pins exactly.
 *
 * @param right - the already-bound element to this compound's right
 * @param combinator - the combinator joining this compound to `right`
 * @param compound - the compound to bind (its structural part is matched)
 * @returns the bound element, or null if none satisfies the relation
 */
function findRelated(right: Element, combinator: Combinator, compound: Compound): Element | null {
	const structural = compound.structural || '*';
	if (combinator === '>') {
		const parent = right.parentElement;
		return parent && safeMatches(parent, structural) ? parent : null;
	}
	if (combinator === ' ') {
		for (let a = right.parentElement; a; a = a.parentElement) if (safeMatches(a, structural)) return a;
		return null;
	}
	if (combinator === '+') {
		const prev = right.previousElementSibling;
		return prev && safeMatches(prev, structural) ? prev : null;
	}
	// Subsequent-sibling: the nearest preceding sibling that matches.
	for (let s = right.previousElementSibling; s; s = s.previousElementSibling) if (safeMatches(s, structural)) return s;
	return null;
}

/**
 * The combinator that safely expresses the relationship between two marked elements in
 * the artifact. Because each marker is unique, a looser combinator cannot match a wrong
 * element, so the only requirement is that it be true for this concrete pair: descendant
 * when right is contained in left, general-sibling when they share a parent and left
 * precedes right. Any other relationship (an "uncle", say) is not expressible by a single
 * combinator and the caller drops the branch.
 *
 * @param left - the earlier marked element
 * @param right - the later marked element
 * @returns the generalized combinator, or null if the relationship is inexpressible
 */
function generalize(left: Element, right: Element): Combinator | null {
	if (left !== right && left.contains(right)) return ' ';
	if (left.parentElement && left.parentElement === right.parentElement) {
		const followsLeft = (left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
		if (followsLeft) return '~';
	}
	return null;
}

/**
 * Builds the output selector for a candidate from its marked compounds: each becomes a
 * `[data-snip-state="n"]` marker carrying its dynamic pseudos and pseudo-element, joined
 * by the generalized combinators.
 *
 * @param cand - the bound candidate
 * @param markerIds - the assigned marker id per element
 * @returns the selector string, or null if any marked element lacks an id
 */
function buildSelector(cand: Candidate, markerIds: Map<Element, number>): string | null {
	const parts: string[] = [];
	for (const m of cand.marked) {
		const id = markerIds.get(m.element);
		if (id === undefined) return null;
		// The marker precedes the pseudo (`[data-…]:hover`, never `:hover[data-…]`), the
		// spelling scoped-css emitters (Vue/Angular) rely on.
		parts.push(`[${MARKER}="${id}"]${m.dynamicPseudos.join('')}${m.pseudoElement}`);
	}
	let selector = parts[0] ?? '';
	for (let k = 1; k < parts.length; k++) {
		const combinator = cand.combinators[k - 1];
		selector += combinator === ' ' ? ` ${parts[k]}` : ` ${combinator} ${parts[k]}`;
	}
	return selector || null;
}

/**
 * Assigns a marker id to every element any candidate marks, numbered by document order
 * for determinism.
 *
 * @param pairs - the [original, clone] subtree pairs, in document order
 * @param candidates - the bound candidates whose marked elements need ids
 * @returns the element -> marker id map
 */
function assignMarkers(pairs: Array<[Element, Element]>, candidates: Candidate[]): Map<Element, number> {
	const needed = new Set<Element>();
	for (const cand of candidates) for (const m of cand.marked) needed.add(m.element);
	const ids = new Map<Element, number>();
	let next = 0;
	for (const [original] of pairs) {
		if (needed.has(original) && !ids.has(original)) ids.set(original, next++);
	}
	return ids;
}

/**
 * Merges one rule's declarations into the per-property cascade winners for a group,
 * keeping the winner by !important, then specificity, then capture order.
 *
 * @param rule - the contributing rule
 * @param order - the rule's capture order
 * @param winners - the per-property winning declaration map, mutated in place
 */
function mergeRule(rule: CssRule, order: number, winners: Map<string, RankedStateDecl>): void {
	for (const [prop, raw] of rule.properties) {
		const important = /!\s*important\s*$/i.test(raw);
		const value = raw.replace(/!\s*important\s*$/i, '').trim();
		if (value === '') continue;
		const cand: RankedStateDecl = { value, important, specificity: rule.specificity, order };
		const cur = winners.get(prop);
		if (!cur || stateWins(cand, cur)) winners.set(prop, cand);
	}
}

/** Cascade ordering: !important beats normal; then higher specificity; then later capture order. */
function stateWins(a: RankedStateDecl, b: RankedStateDecl): boolean {
	if (a.important !== b.important) return a.important;
	if (a.specificity !== b.specificity) return a.specificity > b.specificity;
	return a.order >= b.order;
}

/**
 * Drops every state declaration that merely restates the element's resting value, so the
 * emitted rule stays proportional to the real state change (a `:hover` that restates the
 * resting color contributes nothing). The remainder is emitted !important so it outranks
 * the inline resting value while the state is active.
 *
 * @param winners - the resolved per-property state declarations
 * @param resting - the subject's resting baked styles (its inline style at rest)
 * @returns the formatted, non-redundant declaration lines
 */
function denoise(winners: Map<string, RankedStateDecl>, resting: Map<string, string> | undefined): string[] {
	const lines: string[] = [];
	for (const [prop, decl] of winners) {
		const rest = resting?.get(prop);
		if (rest !== undefined && rest.trim() === decl.value.trim()) continue;
		lines.push(`\t${prop}: ${decl.value} !important;`);
	}
	return lines;
}

/** The branch's full structural selector (each compound's structural part, gates included), for matching. */
function structuralSelector(branch: Complex): string {
	let selector = branch.compounds[0]?.structural || '*';
	for (let k = 1; k < branch.compounds.length; k++) {
		const part = branch.compounds[k]?.structural || '*';
		const combinator = branch.combinators[k - 1];
		selector += combinator === ' ' ? ` ${part}` : ` ${combinator} ${part}`;
	}
	return selector;
}

/** element.matches that swallows the SyntaxError an unsupported selector throws. */
function safeMatches(el: Element, selector: string): boolean {
	try {
		return el.matches(selector);
	} catch {
		return false;
	}
}
