/**
 * capture/states-measure.ts: measure interactive states by forcing them live
 *
 * Pipeline position: capture
 * Reads from Captured: root, foundationRules, componentRules
 * Writes to Captured: measuredStates, warnings
 *
 * Why this exists: the rest of the pipeline establishes fidelity by measuring ground
 * truth: bake.ts renders the live element and trusts an authored value only when it
 * round-trips. Interactive states were the one corner that guessed instead: the reconcile
 * handler copied authored `:hover`/`:focus`/`:active` rules and replayed them, which fails
 * two ways on real components. It silently drops descendant effects a framework encodes
 * out of reach: Tailwind's `group-hover:` compiles to `:is(:where(.group):hover *)`, whose
 * `:hover` is buried inside `:is()`. And it replays a parent rule that rides on an
 * inheritance the resting bake already flattened: a hovered pill turns its text white via
 * inheritance, but the bake froze an explicit per-element color that outranks it.
 *
 * This module restores the measure-don't-copy principle to states. It forces each state in
 * the live browser and reads what actually computes on the trigger and the elements a single
 * combinator can re-anchor to it, its descendants and following siblings, so the engine
 * resolves group-hover, descendant, sibling, and inherited effects for free, with no
 * selector-grammar decoding. The values it records are concrete, already cascade- and
 * inheritance-resolved literals, so the reconcile emit (features/states.ts) is a pure transform
 * with no var() survival or per-property cascade merge left to do.
 *
 * Each scoped element is read on two layers: its own box, and any ::before/::after that
 * generates a box at rest: the common hover idiom of a glow/underline/reveal that lives
 * entirely on a generated box, whose own element style never changes. A pseudo layer is
 * diffed against its own resting baseline and emitted as its own affected entry, so reconcile
 * can re-anchor it as `[marker]:hover::after { ... }` over the resting pseudo the pseudo pass
 * already ships.
 *
 * The forcing is privileged and lives here, beside capture/cdp.ts's other CDP paths, for the
 * same reason: only the background can attach the debugger, since chrome.debugger is
 * background-only, and only the live capture phase has the element, its ancestor chain, and
 * getComputedStyle. It soft-fails exactly like the inherited-chain capture: if the debugger
 * is busy, such as when devtools is open, the snip proceeds and reconcile falls back to copying rules.
 *
 * Determinism: forced values are read under a temporary transitions-off/animations-off shim,
 * so every endpoint is the state's final value read instantaneously, with no mid-transition
 * sampling, no settle-timing flakiness. The page is left exactly as found, with states cleared,
 * shim removed, and tags removed, even on error.
 */
import type { Captured, MeasuredAffected, MeasuredState, MeasuredStateDecl } from '../types';
import { mediaApplies, subtreeElements } from '../reconcile/match';
import { containsDynamicPseudo, findTriggerBearers, safeMatches } from '../reconcile/selector';

/** Unique per-trigger tag so the background can resolve exactly one element to force. */
const FORCE_TAG = 'data-snipcode-force';

/** The transitions-off/animations-off shim that makes the forced read instantaneous. */
const SHIM_TEXT = '*, *::before, *::after { transition: none !important; animation: none !important; }';

/**
 * Work budget: measurement makes a CDP round-trip per trigger-and-state pair and reads computed styles
 * across every scoped element, so both scale with the snip. Beyond these bounds, such as a very
 * large snip like a whole site nav with hundreds of hover rules, measurement degrades to the copy
 * path, the prior behavior, rather than risk timing out. The bounds are counts, so the
 * measure-or-copy decision is a deterministic function of the page.
 */
const MAX_MEASURED_UNITS = 200;
const MAX_MEASURED_SCOPE = 2000;

/**
 * Forces every in-subtree interactive state the page's own rules describe and records the
 * concrete computed delta. Sets captured.measuredStates: an array, possibly empty, when
 * measurement ran, or null when cdp was unavailable so reconcile copies authored rules.
 *
 * @param captured - the in-flight capture; measuredStates + warnings mutated in place
 */
export async function measureInteractiveStates(captured: Captured): Promise<void> {
	const subtree = new Set(subtreeElements(captured.root));
	const triggers = discoverTriggers(captured, subtree);
	// No in-subtree state rule: nothing to force, and no copy fallback is needed either.
	if (triggers.size === 0) {
		captured.measuredStates = [];
		return;
	}

	// Bound the forcing work before doing any of it: too many state units would mean too many CDP
	// round-trips, so degrade to copying authored rules; this is counted before scopes are computed,
	// since that walk is itself proportional to the snip.
	let unitCount = 0;
	for (const states of triggers.values()) unitCount += states.size;
	if (unitCount > MAX_MEASURED_UNITS) {
		captured.warnings.push(`states: ${unitCount} interactive-state rules exceed the measurement budget; falling back to copying authored rules`);
		captured.measuredStates = null;
		return;
	}

	// Each trigger reads only its re-anchorable scope of descendants + following siblings, so the
	// resting baseline is needed for just those elements, not the whole subtree; a large snip
	// with few triggers stays cheap.
	const scopes = new Map<Element, Element[]>();
	const toBaseline = new Set<Element>();
	for (const trigger of triggers.keys()) {
		const scope = triggerScope(trigger, subtree);
		scopes.set(trigger, scope);
		for (const el of scope) toBaseline.add(el);
	}
	// Likewise bound the computed-style reads. A generating ::before/::after adds a read at the
	// baseline and under every forced state, so each is weighted toward the bound; a budget sized
	// for element-only reads would otherwise be undercounted on a pseudo-heavy snip. The generating
	// layers are resolved once here, since content does not depend on the shim, and reused for every read.
	const generating = new Map<Element, string[]>();
	let scopeCost = 0;
	for (const el of toBaseline) {
		const pseudos = generatingPseudos(el);
		if (pseudos.length > 0) generating.set(el, pseudos);
		scopeCost += 1 + pseudos.length;
	}
	if (scopeCost > MAX_MEASURED_SCOPE) {
		captured.warnings.push(`states: ${scopeCost} element/pseudo layers in interactive-state scope exceed the measurement budget; falling back to copying authored rules`);
		captured.measuredStates = null;
		return;
	}

	const shim = installShim();
	try {
		// The resting baseline is read under the same shim as the forced endpoints, so a
		// steady-state animation cannot read as a spurious change between the two.
		const baseline = new Map<Element, MeasuredBaseline>();
		for (const el of toBaseline) baseline.set(el, readMeasuredLayers(el, generating.get(el)));

		const began = await beginForce();
		if (!began) {
			// Cdp refused because devtools or another client is attached: degrade to copying rules.
			captured.warnings.push('states: live measurement unavailable (cdp busy); falling back to copying authored rules');
			captured.measuredStates = null;
			return;
		}

		const tags = tagTriggers([...triggers.keys()]);
		try {
			captured.measuredStates = await measureAll(triggers, tags, scopes, baseline, captured);
		} finally {
			for (const [el] of tags) el.removeAttribute(FORCE_TAG);
			await endForce();
		}
	} catch (err) {
		captured.warnings.push(`states: live measurement failed (${(err as Error).message}); falling back to copying authored rules`);
		captured.measuredStates = null;
	} finally {
		// Detach, done in endForce, has already cleared every forced state; force one synchronous
		// recalc while the shim still suppresses transitions, so the page is materialized at rest
		// before the shim is removed and the later resting bake reads only resting values.
		void document.body?.offsetHeight;
		shim.remove();
	}
}

/**
 * Discovers which elements to force and the states to force on each, entirely from the page's
 * own state rules, never a guess about which elements "look interactive". For every rule
 * whose selector carries a dynamic interactive pseudo and whose @media gate applies, each
 * trigger bearer's structural selector is matched against the subtree; a match is an element
 * to force, keyed to the canonical set of pseudos to force together.
 *
 * Bearers are grouped by their structural selector and resolved with one native
 * querySelectorAll per distinct selector rather than testing every rule against every element,
 * so discovery stays fast on a large snip.
 *
 * @param captured - reads the flattened rule lists; warns on a selector it cannot parse
 * @param subtree - the snip subtree membership set
 * @returns each trigger element to the distinct pseudo-sets, in colon form, to force on it
 */
function discoverTriggers(captured: Captured, subtree: Set<Element>): Map<Element, Map<string, string[]>> {
	// Collect the distinct bearers, keyed by structural selector to pseudo-sets, across every state rule.
	const byStructural = new Map<string, Map<string, string[]>>();
	const unparseable = new Set<string>(); // Warn once per selector.
	for (const rule of [...captured.foundationRules, ...captured.componentRules]) {
		if (!containsDynamicPseudo(rule.selector)) continue;
		if (rule.mediaQuery && !mediaApplies(rule.mediaQuery)) continue;
		let bearers;
		try {
			bearers = findTriggerBearers(rule.selector);
		} catch {
			if (!unparseable.has(rule.selector)) {
				unparseable.add(rule.selector);
				captured.warnings.push(`states: unparseable selector "${rule.selector}"; effect dropped`);
			}
			continue;
		}
		for (const bearer of bearers) {
			const structural = bearer.structural || '*';
			const pseudos = canonicalPseudos(bearer.dynamicPseudos);
			const sets = byStructural.get(structural) ?? new Map<string, string[]>();
			sets.set(pseudos.join(''), pseudos);
			byStructural.set(structural, sets);
		}
	}

	// Resolve each distinct selector to the in-subtree elements that bear it.
	const triggers = new Map<Element, Map<string, string[]>>();
	for (const [structural, pseudoSets] of byStructural) {
		for (const el of matchInSubtree(captured.root, structural, subtree)) {
			const states = triggers.get(el) ?? new Map<string, string[]>();
			for (const [key, pseudos] of pseudoSets) states.set(key, pseudos);
			triggers.set(el, states);
		}
	}
	return triggers;
}

/**
 * Resolves a structural selector to the elements in the snip subtree that match it, the root
 * included, since querySelectorAll only returns descendants, so the root is tested separately.
 *
 * @param root - the snip root
 * @param structural - the bearer's structural selector
 * @param subtree - the snip subtree membership set
 */
function matchInSubtree(root: Element, structural: string, subtree: Set<Element>): Element[] {
	const out: Element[] = [];
	if (safeMatches(root, structural)) out.push(root);
	let matches: NodeListOf<Element>;
	try {
		matches = root.querySelectorAll(structural);
	} catch {
		return out; // An unsupported selector matches nothing standalone; drop it.
	}
	for (const el of matches) if (subtree.has(el)) out.push(el);
	return out;
}

/**
 * Forces each trigger-and-state pair one at a time, reading the trigger scope's computed delta under
 * the force, so descendant/sibling/inherited effects are captured without parsing any
 * relationship. States are isolated: each is cleared before the next is forced.
 *
 * @param triggers - the discovered trigger elements and their pseudo-sets
 * @param tags - each trigger's unique force tag, for the background to resolve
 * @param scopes - each trigger's re-anchorable scope of descendants + following siblings
 * @param baseline - each scoped element's resting computed values, read under the shim
 * @param captured - warnings mutated in place
 * @returns one MeasuredState per trigger-and-state pair that changed at least one element
 */
async function measureAll(
	triggers: Map<Element, Map<string, string[]>>,
	tags: Map<Element, string>,
	scopes: Map<Element, Element[]>,
	baseline: Map<Element, MeasuredBaseline>,
	captured: Captured,
): Promise<MeasuredState[]> {
	const measured: MeasuredState[] = [];
	for (const [trigger, states] of triggers) {
		const selector = `[${FORCE_TAG}="${tags.get(trigger)}"]`;
		const scope = scopes.get(trigger) ?? [trigger];
		for (const pseudos of states.values()) {
			const bare = pseudos.map((p) => p.replace(/^:/, ''));
			const set = await forceState(selector, bare);
			if (!set) {
				captured.warnings.push(`states: could not force ${pseudos.join('')} on a trigger; effect dropped`);
				continue;
			}
			const affected = collectAffected(scope, baseline);
			await forceState(selector, []); // Clear before the next state so they stay isolated.
			if (affected.length > 0) measured.push({ trigger, states: pseudos, affected });
		}
	}
	return measured;
}

/**
 * The elements a forced trigger can restyle in a way the standalone emit can re-anchor: the
 * trigger itself, its descendants via a descendant combinator, and its following same-parent
 * siblings via a general-sibling combinator. A change anywhere else cannot be expressed by a
 * single combinator between two markers, so it would be dropped at emit; not reading it keeps
 * the per-trigger cost proportional to the trigger's own scope rather than the whole snip.
 *
 * @param trigger - the element being forced
 * @param subtree - the snip subtree membership set
 */
function triggerScope(trigger: Element, subtree: Set<Element>): Element[] {
	const scope: Element[] = [trigger];
	for (const el of trigger.querySelectorAll('*')) if (subtree.has(el)) scope.push(el);
	for (let s = trigger.nextElementSibling; s; s = s.nextElementSibling) if (subtree.has(s)) scope.push(s);
	return scope;
}

/** One scoped element's resting computed values, split by layer: the element box and each
 * generating pseudo, so a pseudo delta is diffed against its own baseline, not the element's. */
interface MeasuredBaseline {
	element: Map<string, string>;
	pseudos: Map<string, Map<string, string>>;
}

/**
 * Reads one scoped element's resting computed values across its layers: the element box always,
 * plus each ::before/::after that generates a box at rest, passed in and pre-resolved. Run under
 * the shim, so the values match the forced reads they will be diffed against.
 *
 * @param el - the element to read
 * @param pseudos - the generating pseudo layers for this element, or undefined if none
 */
function readMeasuredLayers(el: Element, pseudos: string[] | undefined): MeasuredBaseline {
	const layers: MeasuredBaseline = { element: readMeasuredProps(el), pseudos: new Map() };
	if (pseudos) for (const pseudo of pseudos) layers.pseudos.set(pseudo, readMeasuredProps(el, pseudo));
	return layers;
}

/**
 * Reads each scoped element's computed values under the currently-forced state and returns the
 * layers that differ from the resting baseline. The element box is one entry; each generating
 * pseudo is its own entry diffed against its own baseline. The trigger itself is included when
 * one of its layers changed; a layer whose style is unchanged contributes nothing.
 *
 * @param scope - the trigger's re-anchorable scope; see triggerScope
 * @param baseline - each scoped element's resting layers, read under the shim
 * @returns one entry per changed element-and-layer, with the changed properties and forced values
 */
function collectAffected(scope: Element[], baseline: Map<Element, MeasuredBaseline>): MeasuredAffected[] {
	const affected: MeasuredAffected[] = [];
	for (const el of scope) {
		const base = baseline.get(el);
		if (!base) continue;
		const elementDecls = diffMeasured(base.element, readMeasuredProps(el));
		if (elementDecls.length > 0) affected.push({ element: el, decls: elementDecls });
		for (const [pseudo, rest] of base.pseudos) {
			const pseudoDecls = diffMeasured(rest, readMeasuredProps(el, pseudo));
			if (pseudoDecls.length > 0) affected.push({ element: el, pseudoElement: pseudo, decls: pseudoDecls });
		}
	}
	return affected;
}

/** The properties whose forced value differs from the resting baseline, one declaration each. */
function diffMeasured(rest: Map<string, string>, forced: Map<string, string>): MeasuredStateDecl[] {
	const decls: MeasuredStateDecl[] = [];
	for (const [property, value] of forced) if (rest.get(property) !== value) decls.push({ property, value });
	return decls;
}

/**
 * The ::before/::after layers that actually generate a box on this element at rest, meaning
 * content is not `none`, the same test the resting pseudo pass (features/pseudo.ts) uses to decide a pseudo is
 * worth shipping. Only these layers carry a resting rule for a hover override to ride on, so a
 * pseudo that does not generate at rest is not measured.
 *
 * @param el - the element to test
 */
function generatingPseudos(el: Element): string[] {
	const out: string[] = [];
	for (const pseudo of ['::before', '::after']) {
		const content = getComputedStyle(el, pseudo).getPropertyValue('content');
		if (content !== '' && content !== 'none' && content !== 'normal') out.push(pseudo);
	}
	return out;
}

/**
 * Reads the measurable computed properties of one element layer into a property->value map. The
 * indexed enumeration is the engine's own stable property list, so the read order, and thus
 * the recorded artifact, is deterministic. Excludes the timing metadata the shim
 * deliberately suppresses, the transition and animation longhands, which would otherwise read
 * as a spurious change, and custom properties, whose resolved properties are measured
 * directly, so no var() ever needs resolving downstream.
 *
 * @param el - the element to read
 * @param pseudo - the generated-box layer to read (`::before`/`::after`), or undefined for the element box
 */
function readMeasuredProps(el: Element, pseudo?: string): Map<string, string> {
	const cs = pseudo ? getComputedStyle(el, pseudo) : getComputedStyle(el);
	const props = new Map<string, string>();
	for (let i = 0; i < cs.length; i++) {
		const name = cs[i];
		if (!name || !isMeasurableProperty(name)) continue;
		props.set(name, cs.getPropertyValue(name));
	}
	return props;
}

/** Whether a property belongs in the endpoint diff; see readMeasuredProps for the why. */
function isMeasurableProperty(name: string): boolean {
	if (name.startsWith('--')) return false;
	if (name.startsWith('transition')) return false;
	if (name.startsWith('animation')) return false;
	if (isLogicalAlias(name)) return false;
	return true;
}

/**
 * Whether a property is a flow-relative, or logical, alias whose physical equivalent
 * getComputedStyle also enumerates with the same value: `inline-size`/`width`,
 * `padding-inline-start`/`padding-left`, `inset-block-end`/`bottom`, and so on. The physical form is
 * always co-measured and universally supported, so reading the logical alias too would emit a
 * redundant second declaration of the same change. The writing mode is frozen in the snip, so
 * the physical form is a faithful stand-in.
 *
 * @param name - the property name
 */
function isLogicalAlias(name: string): boolean {
	return (
		name === 'inline-size' ||
		name === 'block-size' ||
		name.includes('-inline-') ||
		name.includes('-block-') ||
		name.endsWith('-inline') ||
		name.endsWith('-block')
	);
}

/** Normalizes a bearer's pseudos to a canonical, deduplicated, sorted list for stable keying. */
function canonicalPseudos(pseudos: string[]): string[] {
	return [...new Set(pseudos.map((p) => p.toLowerCase()))].sort();
}

/** Tags each trigger with a unique attribute so the background resolves exactly one node. */
function tagTriggers(triggers: Element[]): Map<Element, string> {
	const tags = new Map<Element, string>();
	let n = 0;
	for (const el of triggers) {
		const token = `f${n++}`;
		el.setAttribute(FORCE_TAG, token);
		tags.set(el, token);
	}
	return tags;
}

/** Installs the transitions-off/animations-off shim, returning the node to remove after. */
function installShim(): HTMLStyleElement {
	const style = document.createElement('style');
	style.setAttribute(FORCE_TAG, 'shim');
	style.textContent = SHIM_TEXT;
	document.head.appendChild(style);
	return style;
}

/** Begins the background force session; returns false if cdp is unavailable, a soft-fail. */
async function beginForce(): Promise<boolean> {
	try {
		const res = (await chrome.runtime.sendMessage({ type: 'CDP_FORCE_BEGIN', requestId: crypto.randomUUID(), payload: {} })) as { ok: boolean };
		return !!res?.ok;
	} catch {
		return false;
	}
}

/** Forces a pseudo-state set on one node, or clears it with an empty list; false if not found. */
async function forceState(selector: string, states: string[]): Promise<boolean> {
	try {
		const res = (await chrome.runtime.sendMessage({
			type: 'CDP_FORCE_STATE',
			requestId: crypto.randomUUID(),
			payload: { selector, states },
		})) as { ok: boolean; result?: { found: boolean } };
		return !!res?.ok && res.result?.found !== false;
	} catch {
		return false;
	}
}

/** Ends the background force session: clears emulated media + detaches. Best-effort. */
async function endForce(): Promise<void> {
	await chrome.runtime.sendMessage({ type: 'CDP_FORCE_END', requestId: crypto.randomUUID(), payload: {} }).catch(() => {});
}

