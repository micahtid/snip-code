/**
 * features/states.ts: interactive-state rules (:hover, :focus, :active)
 *
 * Pipeline position: reconcile
 * Reads from Captured: root, clone, measuredStates, foundationRules, componentRules, bakedStyles
 * Writes to Captured: clone, marking elements and appending a <style> of state rules, and warnings
 *
 * This extends the "ship what renders" approach to the interactive states a static
 * snapshot drops, such as a button that lightens on hover, a link that underlines, and an
 * input that rings on focus. The resting cascade discards them because the element is not
 * hovered or focused at capture time, since el.matches('.btn:hover') is false at rest, so
 * each property flattens to its resting value. This handler re-emits them so they reproduce
 * in the standalone artifact.
 *
 * There are two sources of truth, and this handler prefers ground truth. When the capture
 * phase measured the states live (meaning capture/states-measure.ts forced each state and read
 * what actually computed, so captured.measuredStates is non-null), this emits those concrete
 * literals. The engine already resolved the cascade, the inheritance, and every group-hover,
 * descendant, and sibling relationship, so there is nothing left to parse. When measurement did
 * not run (meaning cdp was busy, so measuredStates is null), it falls back to copying the page's
 * authored state rules and re-anchoring their selectors. That reproduces the common case of an
 * element's own `:hover`, but it cannot follow a relationship a framework encodes out of reach.
 *
 * CSS/spec reference: https://developer.mozilla.org/en-US/docs/Web/CSS/:hover, plus
 * :focus, :focus-visible, :focus-within, and :active. The trigger set is the closed spec
 * category of dynamic interactive pseudo-classes. The form-state pseudos such as :checked
 * and :disabled are excluded because they reflect current dom state and are already captured
 * at rest.
 *
 * Why a naive re-emit gets it wrong, and how both paths answer it:
 *  - A resting value ships as an inline style attribute, and a normal inline declaration
 *    outranks every normal selector, since it is resolved before specificity is consulted. So a
 *    state rule in a <style> block has zero effect unless it is !important. This is the same
 *    reason the email inliner juice keeps :hover in a surviving <style>. State declarations are
 *    therefore emitted !important. Because the state selector matches only while the state is
 *    active, the override applies only during interaction and reverts cleanly at rest.
 *  - A captured selector (`body.dark .nav > .btn:hover`) is written against the live page's
 *    classes and ancestor chain, which the emitters rewrite and the artifact does not carry.
 *    Each marked element is re-anchored to a unique data-snip-state marker, a data-* attribute,
 *    so it survives the tailwind and bem emitters that rewrite class. The markers are joined by
 *    a combinator that is sound because the markers are unique. It is descendant when the
 *    trigger contains the affected element, and general-sibling when they share a parent and the
 *    trigger precedes it.
 *  - There is one irreducible boundary. A state whose trigger element is outside the snipped
 *    subtree (`.outside:hover .snipped`) cannot be reproduced, because the artifact does not
 *    contain the thing to force. That effect is dropped with a warning, never a silent or wrong
 *    result.
 *
 * Transform contract: it tags each marked, in-subtree element with a data-snip-state marker and
 * adds `[data-snip-state="n"]:hover {...}` rules, denoised against the resting baked value and
 * emitted !important, to the clone's shared synthesized <style>. See reconcile/synthesized.ts.
 * It touches the clone only. State selectors match nothing at rest, so the resting render is
 * byte-identical.
 * Test fixtures: tests/fixtures/state-{card,form,var,localvar,url,pseudo,transform}.html,
 * registered in tests/fixtures.mjs. The gate measures the resting, state-inactive render.
 */
import type { Captured, CssRule, MeasuredState, MeasuredStateDecl } from '../../types';
import { pairedSubtrees, mediaApplies } from '../match';
import { appendSynthesizedRules } from '../synthesized';
import {
	parseSelectorList,
	containsDynamicPseudo,
	safeMatches,
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
	/** The marked compounds, left to right. The last is the subject, where declarations land. */
	marked: MarkedCompound[];
	/** The combinator between each pair of marked compounds. Its length is marked.length - 1. */
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
 * Reproduces the page's interactive states on the clone, preferring the live measurement
 * when the capture phase produced one and falling back to copying authored rules otherwise.
 *
 * @param captured - clone is mutated in place: markers and an appended <style>
 */
export function apply(captured: Captured): Captured {
	if (captured.measuredStates !== null) return applyMeasured(captured, captured.measuredStates);
	return applyCopied(captured);
}

/**
 * Emits the measured states. Each is already a list of concrete computed deltas keyed to the
 * original elements and their generating pseudo layers. So this maps those to clones, marks
 * them, builds the marker selector with a safe generalized combinator and the layer's
 * pseudo-element, denoises against the resting baseline, and emits the rest !important. A pinned
 * endpoint also gets a coherent transition re-emitted on the element's resting rule, so it
 * animates in both directions rather than snapping on the way out. No cascade merge and no var()
 * survival remain, because the engine resolved both when the value was measured.
 *
 * @param captured - clone is mutated in place: markers and an appended <style>
 * @param measuredStates - the computed deltas per trigger and state from capture/states-measure.ts
 */
function applyMeasured(captured: Captured, measuredStates: MeasuredState[]): Captured {
	if (measuredStates.length === 0) return captured;
	const pairs = pairedSubtrees(captured.root, captured.clone);
	const originalToClone = new Map<Element, Element>(pairs.map(([original, clone]) => [original, clone]));

	// Resolve each measured trigger, state, and affected-element triple to clone elements. An
	// element a later feature handler did not carry into the clone is skipped, since it cannot
	// be re-anchored.
	const units = resolveMeasuredUnits(measuredStates, originalToClone);
	if (units.length === 0) return captured;

	// Number every marked element by clone document order, so markers and the rules keying them
	// are deterministic regardless of the order states were measured in.
	const markerIds = assignMeasuredMarkers(pairs, units);
	for (const [el, id] of markerIds) el.setAttribute(MARKER, String(id));

	// Group declarations by the selector they re-anchor to. Distinct trigger, state, and affected
	// triples produce distinct marker selectors, so a group is normally one triple. The merge is
	// just the natural home for its denoised declarations.
	const groups = new Map<string, Map<string, string>>();
	// The element-box props each affected clone pins across all its states, plus its live original,
	// so one coherent resting transition can be emitted per element below.
	const pinned = new Map<Element, { original: Element; props: Set<string> }>();
	for (const unit of units) {
		const selector = buildMeasuredSelector(unit, markerIds);
		if (!selector) {
			captured.warnings.push(`states: could not anchor a measured ${unit.states.join('')} effect standalone; dropped`);
			continue;
		}
		const winners = groups.get(selector) ?? new Map<string, string>();
		// A pseudo layer is denoised against its own resting pseudo, already shed at capture by the
		// per-pseudo diff, not the element's baked map, which describes a different box. The element
		// box keeps its baked-value baseline.
		const resting = unit.pseudoElement ? undefined : captured.bakedStyles.get(unit.affectedClone);
		denoiseMeasured(unit.decls, resting, winners);
		groups.set(selector, winners);
		// Collect the element box's pinned props. A coherent transition over them is emitted on the
		// resting rule below. Pseudo layers are excluded, because a pseudo's own resting transition,
		// shipped on its pseudo rule, already governs its fade in both directions.
		if (!unit.pseudoElement) {
			const entry = pinned.get(unit.affectedClone) ?? { original: unit.affectedOriginal, props: new Set<string>() };
			for (const prop of winners.keys()) entry.props.add(prop);
			pinned.set(unit.affectedClone, entry);
		}
	}

	const rules: string[] = [];
	for (const [selector, winners] of groups) {
		const lines = [...winners].map(([prop, value]) => `\t${prop}: ${value} !important;`);
		if (lines.length > 0) rules.push(`${selector} {\n${lines.join('\n')}\n}`);
	}
	// Re-emit a coherent transition on each affected element's resting rule, not its state rule, so
	// the pinned endpoints animate when both entering and leaving the state. A transition lives on
	// the base rule by spec. The engine reads timing from the after-change style, which is the
	// hovered state on the way in and the resting state on the way out, so a transition placed only
	// on the :hover rule animates the entry and snaps the exit. The base rule governs both. This is
	// render-neutral, since a transition produces no pixels at rest, so the resting render is
	// unchanged.
	for (const [clone, { original, props }] of pinned) {
		const id = markerIds.get(clone);
		if (id === undefined || props.size === 0) continue;
		const transition = broadenedTransition(original, props);
		if (transition) rules.push(`[${MARKER}="${id}"] {\n\ttransition: ${transition} !important;\n}`);
	}
	appendSynthesizedRules(captured, rules);
	return captured;
}

/** One emit unit: a trigger clone forced into `states`, and one affected clone layer's measured delta. */
interface MeasuredUnit {
	triggerClone: Element;
	states: string[];
	affectedClone: Element;
	/** The affected layer: '' for the element box, '::after'/'::before' for a generated box. */
	pseudoElement: string;
	/** The affected original element, for reading its resting transition live at emit time. */
	affectedOriginal: Element;
	decls: MeasuredStateDecl[];
}

/**
 * Maps each measured trigger, state, and affected triple to its clone counterparts, dropping a
 * triple whose trigger or affected element is absent from the clone.
 *
 * @param measuredStates - the measured deltas keyed to original elements
 * @param originalToClone - the original->clone map from pairedSubtrees
 */
function resolveMeasuredUnits(measuredStates: MeasuredState[], originalToClone: Map<Element, Element>): MeasuredUnit[] {
	const units: MeasuredUnit[] = [];
	for (const ms of measuredStates) {
		const triggerClone = originalToClone.get(ms.trigger);
		if (!triggerClone) continue;
		for (const affected of ms.affected) {
			const affectedClone = originalToClone.get(affected.element);
			if (!affectedClone) continue;
			units.push({
				triggerClone,
				states: ms.states,
				affectedClone,
				pseudoElement: affected.pseudoElement ?? '',
				affectedOriginal: affected.element,
				decls: affected.decls,
			});
		}
	}
	return units;
}

/**
 * Assigns a marker id to every clone element a unit references, trigger or affected, numbered
 * by document order for determinism.
 *
 * @param pairs - the [original, clone] subtree pairs, in document order
 * @param units - the resolved emit units
 */
function assignMeasuredMarkers(pairs: Array<[Element, Element]>, units: MeasuredUnit[]): Map<Element, number> {
	const needed = new Set<Element>();
	for (const unit of units) {
		needed.add(unit.triggerClone);
		needed.add(unit.affectedClone);
	}
	const ids = new Map<Element, number>();
	let next = 0;
	for (const [, clone] of pairs) if (needed.has(clone) && !ids.has(clone)) ids.set(clone, next++);
	return ids;
}

/**
 * Builds the output selector for one unit. It is the trigger marker carrying its state pseudos,
 * then, when the affected element is not the trigger itself, the generalized combinator and the
 * affected marker. The affected layer's pseudo-element, if any, is appended to the subject, as in
 * `[marker]:hover::after` when the trigger is the subject, or `[trigger]:hover [affected]::after`
 * for a descendant. Returns null when the relationship is not expressible by a single combinator.
 *
 * @param unit - the emit unit
 * @param markerIds - the assigned marker id per clone element
 */
function buildMeasuredSelector(unit: MeasuredUnit, markerIds: Map<Element, number>): string | null {
	const triggerId = markerIds.get(unit.triggerClone);
	const affectedId = markerIds.get(unit.affectedClone);
	if (triggerId === undefined || affectedId === undefined) return null;
	const triggerPart = `[${MARKER}="${triggerId}"]${unit.states.join('')}`;
	if (unit.triggerClone === unit.affectedClone) return `${triggerPart}${unit.pseudoElement}`;
	const combinator = generalize(unit.triggerClone, unit.affectedClone);
	if (!combinator) return null;
	const affectedPart = `[${MARKER}="${affectedId}"]${unit.pseudoElement}`;
	return combinator === ' ' ? `${triggerPart} ${affectedPart}` : `${triggerPart} ${combinator} ${affectedPart}`;
}

/**
 * Color-family properties that resolve to `currentColor` when not pinned to a divergent value.
 * This happens either by css default (border, outline, decoration, emphasis, caret, column-rule,
 * and text-stroke) or because reconcile/features/colors.ts normalized an icon's matching literal
 * back to it (fill and stroke). A measured change to one of these that equals the forced `color`
 * is carried by the `color` declaration we already emit. A color pinned to its own divergent
 * value would not have tracked `color` into the diff in the first place, so dropping it is sound.
 * `color` itself, the source, and `-webkit-text-fill-color`, the one channel the resting bake
 * pins per element and so severs the inheritance a text recolor rides, are never dropped this way.
 */
const CURRENT_COLOR_TRACKERS = new Set([
	'caret-color', 'outline-color', 'text-decoration-color', 'text-emphasis-color', 'column-rule-color',
	'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
	'-webkit-text-stroke-color', 'fill', 'stroke',
]);

/** Box-size properties whose css initial value is `auto`, so an unset resting base is `auto`. */
const AUTO_SIZED_PROPS = new Set(['width', 'height', 'inline-size', 'block-size']);

/**
 * Whether a measured property's resting base resolves to `auto`, and so cannot interpolate to
 * the concrete length measured in the state. A transition animates between two values only when
 * both are interpolable. `auto` is not, so a size pinned onto the state over an `auto` base can
 * only snap while every concrete-valued neighbour eases. An `auto`-sized box is content-driven,
 * and the content deltas that grow it are pinned in their own right, so left unpinned it resizes
 * standalone exactly as the live element does when its own `auto` box flows. The base is read as
 * `auto` from the resting bake, or inferred for a size property the bake left unset since its
 * initial value is `auto`. A base already pinned to a concrete length stays pinned and animates.
 *
 * @param property - the measured longhand
 * @param resting - the affected element's resting baked value for it, or undefined when unset
 */
function baseIsAuto(property: string, resting: string | undefined): boolean {
	if (resting !== undefined) return resting.trim() === 'auto';
	return AUTO_SIZED_PROPS.has(property);
}

/**
 * Folds a unit's measured declarations into a selector's winners, dropping any that merely
 * restate the element's resting baked value, cannot animate from an `auto` base, have no effect
 * in this element's context, or only track the forced `color`, so the emitted rule stays
 * proportional to the real change. A later unit for the same selector overwrites an earlier
 * property, but distinct triples carry distinct selectors, so this is just the per-selector
 * accumulation point.
 *
 * @param decls - the measured declarations for this affected element
 * @param resting - the affected clone's resting baked styles
 * @param winners - the per-property winners for the selector, mutated in place
 */
function denoiseMeasured(decls: MeasuredStateDecl[], resting: Map<string, string> | undefined, winners: Map<string, string>): void {
	const present = (prop: string): boolean => {
		const value = decls.find((d) => d.property === prop)?.value ?? resting?.get(prop);
		return value !== undefined && value !== '' && value !== 'none';
	};
	// transform-origin/perspective-origin resolve to per-element pixels, so a size change shifts
	// them, but they only have an effect on a box that actually establishes a transform/perspective.
	const hasTransform = present('transform') || present('translate') || present('rotate') || present('scale');
	const hasPerspective = present('perspective');
	const forcedColor = decls.find((d) => d.property === 'color')?.value;

	for (const decl of decls) {
		const rest = resting?.get(decl.property);
		if (rest !== undefined && rest.trim() === decl.value.trim()) continue;
		if (baseIsAuto(decl.property, rest)) continue; // Auto base cannot interpolate, so leave it content-driven.
		if (decl.property === 'transform-origin' && !hasTransform) continue;
		if (decl.property === 'perspective-origin' && !hasTransform && !hasPerspective) continue;
		if (forcedColor !== undefined && CURRENT_COLOR_TRACKERS.has(decl.property) && decl.value.trim() === forcedColor.trim()) continue;
		winners.set(decl.property, decl.value);
	}
}

/**
 * The transition to broaden onto an affected element's resting rule so its pinned endpoints
 * animate coherently in both directions, or null when none is needed. It reads the element's
 * resting transition live from the original. The measurement shim suppressed it, so it is only
 * readable here, at emit, with the page at rest. Returns null when the element has no real resting
 * transition, since the live element snaps too and adding motion would be wrong, or when the
 * resting transition already covers every changed property, in which case the resting baked
 * transition shipped at rest governs the animation and re-emitting would be redundant. Otherwise
 * it broadens to `all` with the element's longest-running timing, so a property the resting
 * transition does not cover, such as the dot's colors-only timing vs our pinned width, animates
 * in step rather than snapping. This is the deliberate approximation: coordinated motion at the
 * element's rhythm, not exact per-property timing.
 *
 * @param original - the affected live element, read at rest
 * @param changed - the property names the state rules pin on the element
 */
function broadenedTransition(original: Element, changed: Set<string>): string | null {
	const cs = getComputedStyle(original);
	const properties = splitCommas(cs.getPropertyValue('transition-property'));
	const durations = splitCommas(cs.getPropertyValue('transition-duration'));
	const timings = splitCommas(cs.getPropertyValue('transition-timing-function'));
	const delays = splitCommas(cs.getPropertyValue('transition-delay'));
	// Pair each transitioned property with its timing, repeating the shorter lists as the cascade
	// does. Keep only the ones that actually animate (a real, positive duration).
	const entries = properties
		.map((property, i) => ({
			property,
			duration: durations[i % durations.length] ?? '0s',
			timing: timings[i % timings.length] ?? 'ease',
			delay: delays[i % delays.length] ?? '0s',
		}))
		.filter((e) => e.property !== 'none' && durationSeconds(e.duration) > 0);
	if (entries.length === 0) return null;
	const coversAll = entries.some((e) => e.property === 'all');
	const covered = (prop: string): boolean => coversAll || entries.some((e) => e.property === prop);
	if ([...changed].every(covered)) return null;
	const rep = entries.reduce((a, b) => (durationSeconds(b.duration) > durationSeconds(a.duration) ? b : a));
	return `all ${rep.duration} ${rep.timing} ${rep.delay}`;
}

/** Seconds for a CSS <time> (`0.3s`, `300ms`, `0s`), or 0 for anything unparseable. */
function durationSeconds(value: string): number {
	const v = value.trim();
	if (v.endsWith('ms')) return parseFloat(v) / 1000 || 0;
	if (v.endsWith('s')) return parseFloat(v) || 0;
	return parseFloat(v) || 0;
}

/** Splits a comma list at top level, so a `cubic-bezier(..., ...)` timing function stays one entry. */
function splitCommas(value: string): string[] {
	const out: string[] = [];
	let cur = '';
	let depth = 0;
	for (const ch of value) {
		if (ch === '(') depth++;
		else if (ch === ')') depth--;
		else if (ch === ',' && depth === 0) {
			out.push(cur.trim());
			cur = '';
			continue;
		}
		cur += ch;
	}
	if (cur.trim() !== '') out.push(cur.trim());
	return out;
}

/**
 * Reproduces the page's interactive-state rules on the clone by copying their authored
 * declarations. This is the fallback used only when live measurement did not run. It cannot
 * follow a relationship a framework buries in `:is()` or group-hover grammar.
 *
 * @param captured - clone is mutated in place: markers and an appended <style>
 */
function applyCopied(captured: Captured): Captured {
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

	// Group candidates by the selector they re-anchor to. Candidates that target the same
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
 * its @media gate currently applies, the same frozen viewport the resting cascade uses.
 *
 * @param captured - the capture, read for the flattened rule lists and root subtree
 * @param pairs - the [original, clone] subtree pairs, in document order
 * @param originalToClone - membership test + clone lookup for the subtree
 * @returns one candidate per rule-branch and subject-element pair that bound entirely in-subtree
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
 * Binds every marked compound of a branch, the subject plus each compound carrying a
 * dynamic pseudo, to a concrete element, walking the combinator chain leftward from the
 * subject. Structural-only intermediate compounds are gates. They are bound only as stepping
 * stones, never marked.
 *
 * @param branch - the parsed complex selector
 * @param subjectEl - the element matched by the branch's full structural selector
 * @param inSubtree - whether an element belongs to the snipped subtree
 * @returns the marked compounds and their combinators, or null if a state-bearing compound
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
		if (!isSubject && !isStateBearing) continue; // A purely-structural gate, so it is dropped.
		const el = bound[k] ?? null;
		// A state-bearing compound must bind inside the subtree. Otherwise its trigger is
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
 * relations, descendant and subsequent-sibling, which the unique marker then pins exactly.
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
 * element, so the only requirement is that it be true for this concrete pair. It is descendant
 * when right is contained in left, and general-sibling when they share a parent and left
 * precedes right. Any other relationship, such as an "uncle", is not expressible by a single
 * combinator, so the caller drops the branch.
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
 * Builds the output selector for a candidate from its marked compounds. Each becomes a
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
		// The marker precedes the pseudo, `[data-...]:hover` never `:hover[data-...]`, the
		// spelling scoped-css emitters like Vue and Angular rely on.
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

/** Cascade ordering: !important beats normal, then higher specificity, then later capture order. */
function stateWins(a: RankedStateDecl, b: RankedStateDecl): boolean {
	if (a.important !== b.important) return a.important;
	if (a.specificity !== b.specificity) return a.specificity > b.specificity;
	return a.order >= b.order;
}

/**
 * Drops every state declaration that merely restates the element's resting value, so the
 * emitted rule stays proportional to the real state change. A `:hover` that restates the
 * resting color contributes nothing. The remainder is emitted !important so it outranks
 * the inline resting value while the state is active.
 *
 * @param winners - the resolved per-property state declarations
 * @param resting - the subject's resting baked styles, its inline style at rest
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

/** The branch's full structural selector, each compound's structural part with gates included, for matching. */
function structuralSelector(branch: Complex): string {
	let selector = branch.compounds[0]?.structural || '*';
	for (let k = 1; k < branch.compounds.length; k++) {
		const part = branch.compounds[k]?.structural || '*';
		const combinator = branch.combinators[k - 1];
		selector += combinator === ' ' ? ` ${part}` : ` ${combinator} ${part}`;
	}
	return selector;
}
