/**
 * minimize/prune.ts: declaration-level dead-code minimization
 *
 * Pipeline position: minimize, the first phase, right after convert/clean
 * Reads from Captured: page.viewport via the oracle, plus warnings on graceful skip
 * Writes to Captured: nothing. It transforms the emitted stylesheet string.
 *
 * Why this exists: the reproduced stylesheet bakes a full computed style onto every
 * element, so it restates inherited values, repeats ua defaults, and carries no-op
 * declarations by the hundred. This deletes every declaration whose removal leaves the
 * render byte-identical, judged by the computed-style oracle, and drops any rule left
 * empty. It is dead-code elimination one level deeper than convert/clean, which prunes
 * whole unused rules and at-rules but never looks inside a matched rule.
 *
 * The method is universal and verification-first, never example-specific. Declarations
 * are indexed through the browser's own css parser in the oracle frame, never by regex
 * over text, so data-uri braces and nested functions cannot mislead it. Deletion is
 * delta-debugging: a chunk is removed, the oracle checks the render, and the removal is
 * accepted only when the render is unchanged, otherwise the chunk is restored and split.
 * Because every accepted deletion is individually render-verified, the result cannot depend on
 * which site produced the css. There is no property table and no per-site rule anywhere,
 * only the oracle's verdict. A cheap pre-pass batches the declarations most likely to be
 * dead, the ones that merely restate an inherited value, into one check. Whatever it
 * misses the bisection still finds, so the pre-pass only ever saves time, never changes
 * the outcome.
 *
 * State, pseudo, and at rules are out of scope here. Their selectors carry the
 * interactive and generated-content fidelity earlier phases earned, so they are indexed
 * neither for deletion nor rewriting and pass through untouched. See WITHHELD.
 */
import type { Captured } from '../types';
import { withOracle, type RenderOracle } from './oracle';
import { parseSegments, inScopeRule, serializeRules, type Segment } from './declarations';

/**
 * Properties held out of deletion because the resting subtree oracle cannot verify them.
 * Animation and transition carry motion, not resting style. The oracle freezes them, so
 * they look inert at rest and deleting one would silently strip the reveal, hover, and
 * transition motion earlier phases reproduce. Counter properties act across the tree: a
 * counter-increment on one element changes the counter a later sibling's generated content
 * renders, an effect outside the element's own subtree that the subtree-scoped check cannot
 * see. Holding both out by property name is universal.
 */
const UNVERIFIABLE_PROP = /^(animation|transition|counter-)/;

/**
 * Wall-time ceiling for one component's minimization, the safety valve that bounds the
 * delta-debugging on a large component. It is not the mount that costs, which profiling put at
 * a few hundred milliseconds. It is the bisection's per-check style recalc, and on the two
 * largest, most restated components in the corpus, apple and f1, that recalc volume reaches the
 * ceiling and the pass stops early. That is the valve working as designed. Every deletion
 * accepted so far is already render-verified, so shipping the partial result is safe and stays
 * deterministic for a fixed input. Ordinary components finish in well under a second with the
 * valve never near.
 */
const BUDGET_MS = 20_000;

/**
 * The css properties that inherit, from the css spec. Used only by the pre-pass to guess
 * which declarations merely restate an inherited value, so the guess is verified by the
 * oracle and a missing or extra entry only shifts work between the pre-pass and the
 * bisection, never the result. This is universal spec knowledge, the same kind the
 * codebase already encodes for inline, void, and replaced tags, never corpus-derived.
 */
const INHERITED = new Set<string>([
	'azimuth', 'border-collapse', 'border-spacing', 'caption-side', 'caret-color', 'color',
	'color-scheme', 'cursor', 'direction', 'empty-cells', 'font', 'font-family', 'font-feature-settings',
	'font-kerning', 'font-language-override', 'font-optical-sizing', 'font-size', 'font-size-adjust',
	'font-stretch', 'font-style', 'font-synthesis', 'font-variant', 'font-variant-alternates',
	'font-variant-caps', 'font-variant-east-asian', 'font-variant-ligatures', 'font-variant-numeric',
	'font-variant-position', 'font-variation-settings', 'font-weight', 'hyphens', 'image-rendering',
	'letter-spacing', 'line-break', 'line-height', 'list-style', 'list-style-image', 'list-style-position',
	'list-style-type', 'orphans', 'overflow-wrap', 'paint-order', 'pointer-events', 'print-color-adjust',
	'quotes', 'ruby-align', 'ruby-position', 'tab-size', 'text-align', 'text-align-last', 'text-anchor',
	'text-combine-upright', 'text-decoration-skip-ink', 'text-emphasis', 'text-emphasis-color',
	'text-emphasis-position', 'text-emphasis-style', 'text-indent', 'text-justify', 'text-orientation',
	'text-rendering', 'text-shadow', 'text-size-adjust', 'text-transform', 'text-underline-offset',
	'text-underline-position', 'text-wrap', 'visibility', 'white-space', 'white-space-collapse', 'widows',
	'word-break', 'word-spacing', 'word-wrap', 'writing-mode',
	'-webkit-font-smoothing', '-webkit-text-fill-color', '-webkit-text-stroke-color',
	'-webkit-text-stroke-width', '-webkit-text-stroke', '-webkit-text-size-adjust', '-webkit-locale',
]);

/**
 * Measurement of one minimization run, filled when the caller passes a stats sink. The
 * production call sites ignore it. The measurement harness reads it to report deletion
 * rate, char shrink, and wall time from a single snip.
 */
export interface MinimizeStats {
	/** Wall time of the minimization step in milliseconds. */
	ms: number;
	/** In-scope declarations before minimization. */
	declsBefore: number;
	/** In-scope declarations surviving after minimization. */
	declsAfter: number;
	/** Stylesheet length in characters before minimization. */
	charsBefore: number;
	/** Stylesheet length in characters after minimization. */
	charsAfter: number;
}

/**
 * Minimizes an emitted stylesheet by deleting every declaration whose removal is
 * render-invisible, verified by the computed-style oracle. It is graceful by contract, so
 * any infrastructure failure appends a warning and returns the css unchanged, and a snip
 * always ships. It is deterministic. The only await is a one-time font settle at setup, after
 * which the bisection is synchronous and processes declarations in a fixed order, so the
 * same input always yields the same output.
 *
 * @param css - the emitted stylesheet, after convert/clean
 * @param captured - source of the viewport size. Warnings are appended here on skip.
 * @param markup - the emitted root markup the stylesheet targets, mounted in the oracle
 * @param stats - optional measurement sink, filled with this run's numbers when provided
 * @returns the minimized stylesheet, or the input unchanged on any failure
 */
export async function minimizeCss(css: string, captured: Captured, markup: string, stats?: MinimizeStats): Promise<string> {
	if (stats) fillNoOpStats(stats, css);
	// A mid-run failure discards the frame's partial edits and ships the original css,
	// never a half-minimized stylesheet. withOracle owns that fallback.
	return withOracle(css, captured, markup, 'minimize: skipped', (oracle) => {
		const t0 = now();
		const result = run(oracle, stats);
		if (stats) stats.ms = now() - t0;
		return result;
	});
}

/** Initializes a stats sink to a no-op run, so a skip still reports coherent numbers. */
function fillNoOpStats(stats: MinimizeStats, css: string): void {
	stats.ms = 0;
	stats.declsBefore = 0;
	stats.declsAfter = 0;
	stats.charsBefore = css.length;
	stats.charsAfter = css.length;
}

/** A minimizable rule with its parsed segments and a per-segment kept flag. */
interface MinRule {
	rule: CSSStyleRule;
	segs: Segment[];
	kept: boolean[];
}

/** A candidate declaration: which minimizable rule and which segment within it. */
interface DeclRef {
	rIdx: number;
	segIdx: number;
}

/**
 * Runs the minimization against a mounted oracle and returns the serialized result. The
 * oracle frame's own stylesheet is the working copy: declarations are removed from it,
 * checked, and kept or restored, then the surviving rules are serialized back to text.
 *
 * @param oracle - the mounted render whose stylesheet is minimized in place
 * @param stats - optional measurement sink for declaration counts
 */
function run(oracle: RenderOracle, stats?: MinimizeStats): string {
	oracle.captureReference();
	const topRules = Array.from(oracle.sheet.cssRules);

	// Index every in-scope rule's declarations through the parser. A touched rule is a
	// top-level style rule whose selector is not withheld. Its declarations are parsed into
	// author segments, shorthands kept intact, and a candidate is any segment that is not a
	// motion or custom property. Everything else, withheld rules, at-rules, grouping rules,
	// and the held-out segments, is preserved. A per-rule kept flag is the whole working
	// state. A removal rebuilds the rule's cssText from the kept segments, a full re-parse
	// each time, so the frame always renders exactly as a fresh parse of the emitted text
	// would. Per-longhand removeProperty was avoided here because it can leave the live
	// cssom serializing differently than it renders, which makes the oracle unsound.
	const rules: MinRule[] = [];
	const index: DeclRef[] = [];
	for (const rule of topRules) {
		const styleRule = inScopeRule(rule);
		if (!styleRule) continue;
		const segs = parseSegments(styleRule.style.cssText);
		const rIdx = rules.push({ rule: styleRule, segs, kept: segs.map(() => true) }) - 1;
		for (let s = 0; s < segs.length; s++) {
			const prop = segs[s]!.prop;
			if (UNVERIFIABLE_PROP.test(prop) || prop.startsWith('--')) continue;
			index.push({ rIdx, segIdx: s });
		}
	}
	if (stats) {
		stats.declsBefore = index.length;
		// Resting-css chars, the in-scope style rules only, so the shrink metric is not
		// swamped by the inlined @font-face and image data-uris that dominate the byte count
		// and are never touched here.
		stats.charsBefore = rules.reduce((sum, r) => sum + r.rule.cssText.length, 0);
	}
	if (index.length === 0) return serializeRules(topRules);

	const rebuild = (rIdx: number): void => {
		const r = rules[rIdx]!;
		r.rule.style.cssText = r.segs.filter((_, s) => r.kept[s]).map((seg) => seg.decl).join('; ');
	};
	const setKept = (idxs: number[], value: boolean): void => {
		const dirty = new Set<number>();
		for (const i of idxs) {
			const ref = index[i]!;
			rules[ref.rIdx]!.kept[ref.segIdx] = value;
			dirty.add(ref.rIdx);
		}
		for (const rIdx of dirty) rebuild(rIdx);
	};

	// The elements each rule matches, and the target set a removal on that rule can affect,
	// meaning those elements plus their descendants. Computed once so the bisection can check a
	// removal against just the affected subtree rather than the whole render, which is what
	// makes large components finish inside the budget. See oracle.subtreeTargets for why the
	// subtree is a sound scope.
	const matched: Element[][] = rules.map((r) => {
		try {
			return Array.from(oracle.body.querySelectorAll(r.rule.selectorText));
		} catch {
			return [];
		}
	});
	const ruleTargets = matched.map((els) => oracle.subtreeTargets(els));
	const affectedTargets = (idxs: number[]): number[] => {
		const dirty = new Set<number>();
		for (const i of idxs) dirty.add(index[i]!.rIdx);
		const out = new Set<number>();
		for (const rIdx of dirty) for (const t of ruleTargets[rIdx]!) out.add(t);
		return [...out];
	};

	const deadline = now() + BUDGET_MS;
	const all = index.map((_, i) => i);

	// Delta-debugging bisection: remove a chunk, and if the affected subtree still matches
	// the reference keep it removed, otherwise restore it and split. Every accepted removal
	// leaves the frame equal to the reference, so every later check compares against the same
	// baseline.
	const bisect = (idxs: number[]): void => {
		if (idxs.length === 0 || now() > deadline) return;
		setKept(idxs, false);
		if (oracle.matchesSubset(affectedTargets(idxs))) return;
		setKept(idxs, true);
		if (idxs.length === 1) return; // A single declaration that changes the render is kept.
		const mid = Math.floor(idxs.length / 2);
		bisect(idxs.slice(0, mid));
		bisect(idxs.slice(mid));
	};

	// Pre-pass: batch the declarations most likely to be dead, the ones that merely restate
	// an inherited value or a ua default, and try removing them all in one check. A pass
	// clears the whole batch at once, the big win on large components. A fail salvages the
	// batch by bisecting only it, still cheap because it is nearly all removable, so the
	// pre-pass only ever saves checks and never changes the outcome. The bisection then
	// handles whatever the batch left. The batch spans nearly every rule, so it is checked
	// against the whole render.
	const batch = redundantDefaults(oracle, rules, index, matched, uaDefaults(oracle, matched, rules, index));
	const inBatch = new Set(batch);
	const rest = all.filter((i) => !inBatch.has(i));
	if (batch.length > 0) {
		setKept(batch, false);
		if (!oracle.matchesReference()) {
			setKept(batch, true);
			bisect(batch);
		}
	}
	bisect(rest);

	// Soundness fallback: with reliable rebuild the frame equals the reference here, but if
	// some pathological cascade left it diverging, restore everything and ship the input
	// unchanged rather than a wrong render.
	if (!oracle.matchesReference()) {
		for (let rIdx = 0; rIdx < rules.length; rIdx++) {
			rules[rIdx]!.kept.fill(true);
			rebuild(rIdx);
		}
	}

	if (stats) {
		stats.declsAfter = index.filter((ref) => rules[ref.rIdx]!.kept[ref.segIdx]).length;
		stats.charsAfter = rules.reduce((sum, r) => sum + (r.rule.style.length > 0 ? r.rule.cssText.length : 0), 0);
	}
	return serializeRules(topRules);
}

/**
 * The candidate indices most likely to be dead, the pre-pass batch. A candidate qualifies
 * when, for every element its rule matches, removing it would leave the element at the
 * same computed value it already has. For an inherited property that means the element
 * already equals its parent, and for a non-inherited property it means the element already
 * equals the ua default for its tag. A candidate on a rule that matches nothing also
 * qualifies, since removing it can change no render. A shorthand reads as empty in computed
 * style and is left to the bisection. This is only a guess, since a value can equal the
 * default yet be load-bearing over a lower-cascade rule. The oracle verifies the batch, so
 * a wrong guess only costs the batch a re-bisection, never correctness.
 *
 * @param oracle - the mounted render, read only here
 * @param rules - the minimizable rules, index-aligned with the candidate index
 * @param index - the candidate declarations
 * @param matched - the elements each rule matches, index-aligned with rules
 * @param defaults - ua default values per tag for the non-inherited candidate props
 */
function redundantDefaults(
	oracle: RenderOracle,
	rules: MinRule[],
	index: DeclRef[],
	matched: Element[][],
	defaults: Map<string, Map<string, string>>,
): number[] {
	const win = oracle.win;
	const out: number[] = [];
	for (let i = 0; i < index.length; i++) {
		const { rIdx, segIdx } = index[i]!;
		const els = matched[rIdx]!;
		if (els.length === 0) {
			out.push(i);
			continue;
		}
		const prop = rules[rIdx]!.segs[segIdx]!.prop;
		let redundant = true;
		for (const el of els) {
			const own = win.getComputedStyle(el).getPropertyValue(prop);
			// A shorthand reads as empty and cannot be judged this way, so leave it to the bisection.
			if (own === '') {
				redundant = false;
				break;
			}
			const baseline = INHERITED.has(prop)
				? el.parentElement && win.getComputedStyle(el.parentElement).getPropertyValue(prop)
				: defaults.get(el.tagName)?.get(prop);
			if (baseline == null || own !== baseline) {
				redundant = false;
				break;
			}
		}
		if (redundant) out.push(i);
	}
	return out;
}

/**
 * The ua default value of each non-inherited candidate property, per element tag. Reads it
 * from a bare element of that tag mounted transiently in the frame, so the value is the
 * engine's own initial, never a hand-written table. The bare element is appended, read, and
 * removed while no comparison is in flight, so its transient presence perturbs nothing. A
 * layout property reads a context-dependent value on a bare element, so it will not match a
 * real element and simply never joins the batch, which is what keeps risky sizes such as a
 * form control's intrinsic height out of the fast path and in the verified bisection.
 *
 * @param oracle - the mounted render
 * @param matched - the elements each rule matches, index-aligned with rules
 * @param rules - the minimizable rules
 * @param index - the candidate declarations
 */
function uaDefaults(oracle: RenderOracle, matched: Element[][], rules: MinRule[], index: DeclRef[]): Map<string, Map<string, string>> {
	const props = new Set<string>();
	for (const { rIdx, segIdx } of index) {
		const prop = rules[rIdx]!.segs[segIdx]!.prop;
		if (!INHERITED.has(prop)) props.add(prop);
	}
	const tags = new Set<string>();
	for (const els of matched) for (const el of els) tags.add(el.tagName);

	const win = oracle.win;
	const doc = oracle.body.ownerDocument;
	const out = new Map<string, Map<string, string>>();
	for (const tag of tags) {
		let bare: Element;
		try {
			bare = doc.createElement(tag.toLowerCase());
		} catch {
			continue; // Not a creatable tag name, so its elements fall to the bisection.
		}
		oracle.body.appendChild(bare);
		const cs = win.getComputedStyle(bare);
		const values = new Map<string, string>();
		for (const prop of props) values.set(prop, cs.getPropertyValue(prop));
		out.set(tag, values);
		bare.remove();
	}
	return out;
}

/** Monotonic wall-clock reading for the budget, in milliseconds. */
function now(): number {
	return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}
