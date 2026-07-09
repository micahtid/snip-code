/**
 * minimize/oracle.ts: computed-style render oracle for the minimizer
 *
 * Pipeline position: minimize, the deletion/rewrite verifier used by every minimize phase
 * Reads from Captured: page.viewport, to size the frame like the pasted-snip environment
 * Writes to Captured: nothing. It operates on a private iframe and the emitted stylesheet.
 *
 * Why this exists: the minimizer proposes a candidate edit to the emitted stylesheet, such
 * as deleting a declaration, folding a shorthand, or hoisting a rule, and needs a fast,
 * conservative way to decide whether that edit changed the render. This module is that
 * decision. It mounts the emitted markup plus its stylesheet in a hidden, viewport-sized
 * iframe carrying only the ua stylesheet, the same isolated environment
 * reconcile/standalone.ts validates against. It snapshots getComputedStyle for every element
 * and its ::before/::after, then after a candidate edit re-reads and compares. Equal
 * computed styles on an unchanged dom imply an identical render, so accepting only edits
 * that leave every computed longhand unchanged is strictly conservative. It can keep a
 * declaration that was in fact dead, but it can never delete one that was load-bearing.
 *
 * The comparison is universal by construction. It enumerates the full computed longhand
 * set the engine reports, never a hand-picked property list, and compares before against
 * after in the SAME frame, so any divergence is caused by the edit rather than by
 * standalone context. There is no property table, no selector knowledge, and no per-site
 * tuning anywhere in the oracle. It only knows how to ask the browser whether two renders
 * are computationally identical.
 *
 * The edit is applied to the live stylesheet the frame renders from, exposed as `sheet`,
 * so mutating a rule's declarations reflows the frame and the next comparison sees the
 * result. The whole cycle is synchronous. Because there is no await, the frame never yields
 * to load a font or run a timer mid-run, so the compared font and layout state is fixed and
 * the verdict is deterministic.
 */
import type { Captured } from '../types';
import { createSizedFrame } from '../reconcile/standalone';

/** One computed-style target: an element box, or one of its generated pseudo boxes. */
interface Target {
	el: Element;
	/** '' for the element box, '::before'/'::after' for a generated box. */
	pseudo: string;
}

/**
 * A mounted render whose computed styles can be snapshotted and re-compared after an edit
 * to `sheet`. Created by createRenderOracle, disposed by the caller.
 */
export interface RenderOracle {
	/** The live stylesheet the frame renders from. The minimizer mutates its rules. */
	readonly sheet: CSSStyleSheet;
	/** The frame window, for reading computed styles of the mounted elements. */
	readonly win: Window;
	/** The frame body holding the mounted markup, for selecting the elements a rule matches. */
	readonly body: Element;
	/** Snapshots the current render as the reference every later edit is judged against. */
	captureReference(): void;
	/** Whether the current render's computed styles match the captured reference exactly. */
	matchesReference(): boolean;
	/**
	 * Whether the given targets still match the reference, the rest of the tree assumed
	 * unchanged. Sound only when the caller passes every target a removal could have
	 * touched (see subtreeTargets). This is the fast path the bisection uses so a removal
	 * on a few rules is checked against a small subtree rather than the whole render.
	 */
	matchesSubset(targetIdxs: number[]): boolean;
	/**
	 * The target indices covering the given elements and all their descendants, including
	 * pseudo targets. A removal on a rule can only change the elements it matches and their
	 * descendants, by inheritance or containing-block sizing. Any further layout shift on an
	 * ancestor or sibling is a consequence of a size change on one of these, which is caught
	 * on that element first. So checking this set is sound for a removal touching those rules.
	 */
	subtreeTargets(elements: Element[]): number[];
	/** Tears down the iframe. */
	dispose(): void;
}

/**
 * Mounts the emitted markup and stylesheet in an isolated, viewport-sized frame and
 * returns an oracle over that render. Awaits the frame's fonts before returning so its
 * metrics match the shipped render, which also waits for fonts. Without this a
 * font-metric-dependent size, such as a form control's intrinsic height, would compute
 * differently here than it ships and the oracle could accept a removal that shifts it.
 * The fonts load from the stylesheet's inlined data-uris, so this settles quickly and
 * needs no network. Throws if the frame or its stylesheet cannot be created, which the
 * caller treats as an infrastructure failure and skips the phase.
 *
 * @param captured - source of the capture viewport size
 * @param css - the emitted stylesheet, mounted whole so the render context is complete
 * @param markup - the emitted root markup, mounted as the frame body's content
 */
export async function createRenderOracle(captured: Captured, css: string, markup: string): Promise<RenderOracle> {
	const sized = createSizedFrame(captured, true);
	let sheet: CSSStyleSheet;
	let styleEl: HTMLStyleElement;
	try {
		styleEl = sized.doc.createElement('style');
		styleEl.textContent = css;
		sized.doc.head.appendChild(styleEl);
		if (!styleEl.sheet) throw new Error('stylesheet did not attach');
		sheet = styleEl.sheet;
		sized.doc.body.innerHTML = markup;
		// Neutralize motion so no computed value is time-dependent. A running animation or a
		// transition fired by a candidate removal would otherwise make getComputedStyle return
		// a mid-flight value on each read and defeat the before/after comparison, silently
		// accepting a removal whose effect is still animating in. This frozen state is the
		// oracle's own and is never part of the serialized output. Motion declarations survive
		// because prune.ts holds them out of removal.
		//
		// It is applied as inline styles on every element, not only a stylesheet rule, because
		// a stylesheet `*{...!important}` loses the cascade to any author rule with a more
		// specific `!important` selector, such as a `[data-snip-state] { transition: all
		// !important }` measured-state rule. Inline `!important` outranks every selector rule,
		// so the freeze always wins. A stylesheet rule still covers the generated pseudo boxes,
		// which cannot carry an inline style.
		const pseudoFreeze = sized.doc.createElement('style');
		pseudoFreeze.textContent = '*::before,*::after{animation:none!important;transition:none!important}';
		sized.doc.head.appendChild(pseudoFreeze);
		for (const el of Array.from(sized.doc.body.querySelectorAll('*'))) {
			(el as HTMLElement).style.setProperty('animation', 'none', 'important');
			(el as HTMLElement).style.setProperty('transition', 'none', 'important');
		}
	} catch (err) {
		sized.frame.remove();
		throw err instanceof Error ? err : new Error(String(err));
	}

	const win = sized.win;
	// Settle the frame's fonts before reading any metric, bounded so a face that never
	// resolves cannot hang the phase. document.fonts.ready settles on both success and
	// failure of the inlined faces, so the timeout is only a guard against a pathological
	// pending load, not the normal path.
	try {
		await Promise.race([
			win.document.fonts.ready,
			new Promise<void>((resolve) => win.setTimeout(resolve, 2000)),
		]);
	} catch {
		// FontFaceSet unavailable, so proceed with whatever metrics the frame reports.
	}
	// Every element box, plus a generated pseudo box only when it renders content. Comparing
	// a painting pseudo matters because a declaration on the element, say color, is inherited
	// by a ::before that paints, so deleting it can change the pseudo even when the element
	// box is untouched. A pseudo with no content generates no box and can never gain one from
	// a deletion, since deletion cannot add a content declaration, so skipping it is safe and
	// removes most of the pseudo targets. The dom never changes during minimization, so this
	// target list is stable.
	const targets: Target[] = [];
	// Element to the indices of its own targets (box plus any painting pseudo), so a subtree
	// of elements can be mapped to the exact targets to re-check.
	const elToTargets = new Map<Element, number[]>();
	for (const el of Array.from(sized.doc.body.querySelectorAll('*'))) {
		const idxs: number[] = [];
		idxs.push(targets.push({ el, pseudo: '' }) - 1);
		for (const pseudo of ['::before', '::after']) {
			if (win.getComputedStyle(el, pseudo).content !== 'none') idxs.push(targets.push({ el, pseudo }) - 1);
		}
		elToTargets.set(el, idxs);
	}

	// The master property list, read once and shared across every snapshot. It starts from
	// the longhands getComputedStyle enumerates, which is the same set for every element in
	// one engine, then adds every property the stylesheet actually declares. That union
	// matters because getComputedStyle does not enumerate some non-standard properties that
	// still paint, such as -webkit-font-smoothing and text-rendering. Without them a
	// declaration for such a property could be deleted with no computed-style change the
	// oracle can see, yet the render would shift. getPropertyValue reads them regardless, and
	// a declared shorthand simply reads as empty in both snapshots, so adding extras is safe.
	// Empty when the markup mounted no elements, in which case there is nothing to verify.
	const masterProps: string[] = [];
	const seenProp = new Set<string>();
	if (targets.length > 0) {
		const cs = win.getComputedStyle(targets[0]!.el);
		for (let i = 0; i < cs.length; i++) {
			const prop = cs.item(i);
			if (prop && !seenProp.has(prop)) {
				seenProp.add(prop);
				masterProps.push(prop);
			}
		}
		for (const rule of Array.from(sheet.cssRules)) {
			if (rule.type !== CSSRule.STYLE_RULE) continue;
			const style = (rule as CSSStyleRule).style;
			for (let i = 0; i < style.length; i++) {
				const prop = style[i];
				if (prop && !prop.startsWith('--') && !seenProp.has(prop)) {
					seenProp.add(prop);
					masterProps.push(prop);
				}
			}
		}
	}

	const propIndex = new Map<string, number>();
	masterProps.forEach((prop, i) => propIndex.set(prop, i));

	let reference: string[][] | null = null;
	// Per-target prop indices whose value is paint-irrelevant and so excluded from the
	// comparison, letting the oracle accept removing a declaration that changes computed
	// style but paints nothing. Computed once from the reference render (see paintIrrelevant).
	let skips: Set<number>[] = [];

	const readTarget = (t: Target): CSSStyleDeclaration =>
		win.getComputedStyle(t.el, t.pseudo || undefined);

	return {
		get sheet() {
			return sheet;
		},
		get win() {
			return win;
		},
		get body() {
			return sized.doc.body;
		},
		captureReference() {
			reference = targets.map((t) => {
				const cs = readTarget(t);
				return masterProps.map((prop) => cs.getPropertyValue(prop));
			});
			skips = reference.map((values) => paintIrrelevant(values, propIndex));
		},
		matchesReference() {
			for (let ti = 0; ti < targets.length; ti++) if (!targetMatches(ti)) return false;
			return reference !== null;
		},
		matchesSubset(targetIdxs: number[]) {
			if (!reference) return false;
			for (const ti of targetIdxs) if (!targetMatches(ti)) return false;
			return true;
		},
		subtreeTargets(elements: Element[]) {
			const out = new Set<number>();
			for (const el of elements) {
				for (const idx of elToTargets.get(el) ?? []) out.add(idx);
				for (const d of Array.from(el.querySelectorAll('*'))) {
					for (const idx of elToTargets.get(d) ?? []) out.add(idx);
				}
			}
			return [...out];
		},
		dispose() {
			sized.frame.remove();
		},
	};

	/**
	 * Whether one target's current computed values still match the reference, skipping the
	 * paint-irrelevant properties. Exact string equality is the most conservative test, because
	 * any change a removal causes differs here, while a true no-op leaves every value identical.
	 * Early exit keeps the common reject path cheap.
	 */
	function targetMatches(ti: number): boolean {
		if (!reference) return false;
		const cs = readTarget(targets[ti]!);
		const ref = reference[ti]!;
		const skip = skips[ti]!;
		for (let pi = 0; pi < masterProps.length; pi++) {
			if (skip.has(pi)) continue;
			if (cs.getPropertyValue(masterProps[pi]!) !== ref[pi]) return false;
		}
		return true;
	}
}

/**
 * Mounts a render oracle over a stylesheet and markup, runs a minimize phase's transform
 * against it, and guarantees the frame is torn down. Every phase shares this scaffold. It skips
 * empty input, mounts the oracle, and runs the transform. On any infrastructure failure at
 * either step it appends `<skipLabel> (<cause>)` and ships the input css unchanged, so a snip
 * never fails on a minimize step. A phase with an additional cheap precondition checks it
 * before calling this, to avoid mounting a frame it does not need.
 *
 * @param css - the stylesheet this phase transforms
 * @param captured - source of the viewport size. The skip warning is appended here.
 * @param markup - the emitted root markup the stylesheet targets, mounted in the oracle
 * @param skipLabel - the warning prefix for this phase, e.g. `merge: skipped`
 * @param transform - runs against the mounted oracle and returns the phase's result css
 * @returns the transform's result, or the input css unchanged on any failure
 */
export async function withOracle(
	css: string,
	captured: Captured,
	markup: string,
	skipLabel: string,
	transform: (oracle: RenderOracle) => string,
): Promise<string> {
	if (!css.trim() || !markup.trim()) return css;
	let oracle: RenderOracle;
	try {
		oracle = await createRenderOracle(captured, css, markup);
	} catch (err) {
		captured.warnings.push(`${skipLabel} (${(err as Error).message})`);
		return css;
	}
	try {
		return transform(oracle);
	} catch (err) {
		captured.warnings.push(`${skipLabel} (${(err as Error).message})`);
		return css;
	} finally {
		oracle.dispose();
	}
}

/**
 * The prop indices whose value paints nothing in the reference render, so a removal that
 * only changes them is render-neutral even though the computed value differs. This is the
 * paint-relevance relaxation that closes the gap between the strict computed-style
 * comparison and what actually paints:
 *
 * - A border side with zero width paints no line, so its color and style are irrelevant.
 * - An outline with style none paints nothing, so its color and width are irrelevant.
 * - text-emphasis paints marks only when its style is set. With style none no mark paints,
 *   so the emphasis color is irrelevant however inheritance resolves it.
 * - caret-color paints only the text caret, which shows only in a focused editable field and
 *   never in this resting render, so a caret-color that already equals the color it falls
 *   back to when unset is redundant here. It is skipped only where it equals color, and where
 *   it differs it is kept. This is judged per target, so an inherited value equal to an
 *   ancestor's color but not a descendant's own color is caught on that descendant and kept.
 * - a text decoration line of none paints no underline, overline, or line-through, so its
 *   color, style, and thickness are irrelevant.
 * - text-stroke paints the glyph outline only at a non-zero width. With zero width the stroke
 *   color paints nothing, so it is irrelevant. -webkit-text-fill-color stays compared, since it
 *   paints the glyph body at rest and a prior relaxation of it regressed the hover color freeze.
 * - a column rule of style none paints no rule between columns, so its color and width are
 *   irrelevant, the same shape as the outline relaxation.
 * - -webkit-tap-highlight-color paints only the flash on a mobile tap, never a resting or hover
 *   pixel, so it is skipped unconditionally. This is the one deliberate trade in the set: a tap
 *   flash may differ from the source site, accepted here explicitly rather than slipped through.
 *
 * Each painting relaxation is judged from the reference values alone. A removal that instead
 * makes the property paint, by raising a width from zero, a style off none, or a decoration
 * line on, changes a gating property that is never skipped, so the comparison still catches it
 * and the relaxation can never mask a real change. All of these relaxations are layout-safe
 * because none of the skipped properties affect layout.
 *
 * @param values - the reference computed values, index-aligned with masterProps
 * @param propIndex - masterProps name to its index
 */
function paintIrrelevant(values: string[], propIndex: Map<string, number>): Set<number> {
	const skip = new Set<number>();
	const mark = (prop: string): void => {
		const i = propIndex.get(prop);
		if (i !== undefined) skip.add(i);
	};
	for (const side of ['top', 'right', 'bottom', 'left']) {
		const wi = propIndex.get(`border-${side}-width`);
		if (wi !== undefined && parseFloat(values[wi]!) === 0) {
			mark(`border-${side}-color`);
			mark(`border-${side}-style`);
		}
	}
	const osi = propIndex.get('outline-style');
	if (osi !== undefined && values[osi] === 'none') {
		mark('outline-color');
		mark('outline-width');
	}
	const tes = propIndex.get('text-emphasis-style');
	if (tes !== undefined && values[tes] === 'none') mark('text-emphasis-color');
	const ci = propIndex.get('color');
	const cci = propIndex.get('caret-color');
	if (ci !== undefined && cci !== undefined && values[cci] === values[ci]) mark('caret-color');
	const tdl = propIndex.get('text-decoration-line');
	if (tdl !== undefined && values[tdl] === 'none') {
		mark('text-decoration-color');
		mark('text-decoration-style');
		mark('text-decoration-thickness');
	}
	const tsw = propIndex.get('-webkit-text-stroke-width');
	if (tsw !== undefined && parseFloat(values[tsw]!) === 0) mark('-webkit-text-stroke-color');
	const crs = propIndex.get('column-rule-style');
	if (crs !== undefined && values[crs] === 'none') {
		mark('column-rule-color');
		mark('column-rule-width');
	}
	mark('-webkit-tap-highlight-color');
	return skip;
}
