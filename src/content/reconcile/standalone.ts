/**
 * reconcile/standalone.ts: standalone-context reconciliation + completeness probe
 *
 * Pipeline position: reconcile (closing step, after bake + features + denoise)
 * Reads from Captured: root, clone, bakedStyles, page.viewport
 * Writes to Captured: bakedStyles + clone (in fix mode), warnings
 *
 * Why this exists: bake.ts validates each authored value by forcing it onto the
 * LIVE element and re-reading getComputedStyle. That live-context test passes for
 * values that only resolve because the page is present, a `var(--token)` defined on
 * :root, an inherited body font, an ancestor-relative length, then those values
 * dangle once the snip is pasted standalone. The artifact's own render is the only
 * authority on what survives, so this module makes that render the source of truth:
 * it mounts the baked clone in an isolated iframe that carries only the ua stylesheet
 * (no page author rules, exactly the pasted-snip environment) and, per element,
 * compares the clone's standalone computed style against the original's live computed
 * style. Where they diverge, the standalone artifact is wrong, so the original's
 * resolved value is baked, overriding any authored value that does not reproduce
 * standalone. One anchor fixes missing backgrounds, dangling tokens, lost display,
 * and dropped box props at once, because they are all the same defect.
 *
 * The same anchor extends to structure: an element rendered in the original but
 * absent from the clone (silently dropped by some earlier handler) is restored, so a
 * dropped element is corrected universally rather than by special-casing the handler
 * that dropped it.
 *
 * Report mode (probeStandalone) runs the diff without mutating, returning the exact
 * counts of dropped properties and elements. It is deterministic and drift-free (no
 * live screenshot), so it is the trustworthy completeness signal the measurement loop
 * gates on before trusting SSIM.
 */
import type { Captured } from '../types';
import { pairedSubtrees, isInjected } from './match';

/** The result of diffing the standalone clone against the live original. */
export interface StandaloneReport {
	/** Total property discrepancies across all paired elements. */
	droppedProps: number;
	/** Elements present in the original subtree but missing from the clone. */
	droppedEls: number;
	/** The properties that diverge most often, for diagnosis (bounded). */
	topProps: Array<{ prop: string; count: number }>;
	/** A bounded sample of concrete discrepancies, for diagnosis. */
	samples: Array<{ path: string; prop: string; live: string; standalone: string }>;
}

/** One direction of the emitted-artifact diff: the count, the worst properties, samples. */
export interface EmittedDelta {
	/** Total property discrepancies across all paired elements in this direction. */
	droppedProps: number;
	/** The properties that diverge most often, for diagnosis (bounded). */
	topProps: Array<{ prop: string; count: number }>;
	/** A bounded sample of concrete discrepancies, for diagnosis. */
	samples: Array<{ path: string; prop: string; a: string; b: string }>;
}

/**
 * The result of the emitted-artifact probe: the shipped BEM artifact's render diffed
 * against the live original (delta A) and against the inline-clone's standalone render
 * (delta B), plus the count of delta-A properties whose value never reached the emitted
 * CSS (the absent-at-bake subset, distinct from a render-time cascade loss).
 */
export interface EmittedReport {
	/** Emitted standalone vs live original: the true shipped residual. */
	deltaA: EmittedDelta;
	/** Emitted standalone vs inline-clone standalone: the convert/emit cascade loss. */
	deltaB: EmittedDelta;
	/** The subset of delta-A discrepancies whose live value is absent from the emitted CSS. */
	absentProps: number;
}

/**
 * Properties excluded from the standalone comparison, because a divergence there is
 * benign context, not a lost style. Two groups:
 *
 * - Used-value geometry (width/height/insets/margins and their logical aliases): a
 *   reparented box legitimately resolves a different used size, and that size follows
 *   from the box model and the recovered paint/box properties once those are baked.
 *   bake.ts already locks the root's escaped geometry; freezing every descendant's box
 *   would bloat the output and fight the display/padding the reconciliation restores.
 * - Geometry-derived and non-visual props (transform/perspective origins resolve from
 *   the box; -webkit-locale is an input-method hint with no paint effect).
 *
 * Custom properties are handled separately (they never enumerate in computed style).
 * Everything else is compared: the standalone render is the authority, so any
 * divergence in a paint or box property is a real defect to correct.
 */
const SKIP_PROPS = new Set<string>([
	'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
	'inline-size', 'block-size', 'min-inline-size', 'min-block-size', 'max-inline-size', 'max-block-size',
	'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
	'top', 'right', 'bottom', 'left',
	'inset-block-start', 'inset-block-end', 'inset-inline-start', 'inset-inline-end',
	'transform-origin', 'perspective-origin', '-webkit-locale',
]);

/**
 * Reports the standalone-vs-live discrepancies without mutating anything. This is the
 * completeness instrument: it measures exactly what the artifact fails to reproduce,
 * independent of any live rendering.
 *
 * @param captured - the reconciled capture (read-only here)
 */
export function probeStandalone(captured: Captured): StandaloneReport {
	const report: StandaloneReport = { droppedProps: 0, droppedEls: 0, topProps: [], samples: [] };
	report.droppedEls = countDroppedElements(captured.root, captured.clone);
	const counts = new Map<string, number>();
	try {
		withStandaloneFrame(captured, (mapCloneToFrame, win) => {
			const pairs = pairedSubtrees(captured.root, captured.clone);
			for (const [original, clone] of pairs) {
				const framed = mapCloneToFrame.get(clone);
				if (!framed) continue;
				const live = getComputedStyle(original);
				const standalone = win.getComputedStyle(framed);
				for (const prop of comparableProps(live)) {
					const liveVal = live.getPropertyValue(prop);
					const stdVal = standalone.getPropertyValue(prop);
					if (valuesMatch(liveVal, stdVal)) continue;
					report.droppedProps++;
					counts.set(prop, (counts.get(prop) ?? 0) + 1);
					if (report.samples.length < 40) {
						report.samples.push({ path: pathOf(captured.root, original), prop, live: liveVal, standalone: stdVal });
					}
				}
			}
		});
	} catch (err) {
		captured.warnings.push(`standalone probe: skipped (${(err as Error).message})`);
	}
	report.topProps = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([prop, count]) => ({ prop, count }));
	return report;
}

/**
 * The emitted-artifact probe: renders the final BEM class-based artifact in an isolated
 * iframe and diffs each element's computed style against the live original (delta A) and
 * against the inline-clone's own standalone render (delta B). Where probeStandalone above
 * validates the intermediate inline clone, this validates the artifact that actually
 * ships, so it is the anchor the measurement loop gates on.
 *
 * delta B isolates the convert/emit cascade loss: clean.ts is verified lossless, so any
 * clone->emitted computed-style divergence is the BEM class cascade resolving differently
 * than the inline styles it replaced. delta A is the true shipped residual versus the live
 * element; absentProps counts the subset of delta A whose needed value never reached the
 * emitted CSS at all (an upstream capture/bake gap, not a cascade defect). Both renders use
 * the same drift-free iframe as probeStandalone, so the probe is deterministic.
 *
 * @param captured - the reconciled capture (root + clone, read-only here)
 * @param emittedHtml - the emitted root markup (emitBem output, before doc assembly)
 * @param emittedCss - the shipped stylesheet (after cleanCss)
 */
export function probeEmitted(captured: Captured, emittedHtml: string, emittedCss: string): EmittedReport {
	const report: EmittedReport = {
		deltaA: { droppedProps: 0, topProps: [], samples: [] },
		deltaB: { droppedProps: 0, topProps: [], samples: [] },
		absentProps: 0,
	};
	const aCounts = new Map<string, number>();
	const bCounts = new Map<string, number>();
	let cloneSized: SizedFrame | null = null;
	let emittedSized: SizedFrame | null = null;
	try {
		// Render the inline clone and the emitted artifact in two separate frames (the
		// emitted stylesheet must not match the clone's author classes, so they cannot
		// share a document). Both are the pasted-snip environment: ua stylesheet only.
		cloneSized = createSizedFrame(captured);
		const framedClone = cloneSized.doc.importNode(captured.clone, true) as Element;
		cloneSized.doc.body.appendChild(framedClone);

		emittedSized = createSizedFrame(captured);
		const styleEl = emittedSized.doc.createElement('style');
		styleEl.textContent = emittedCss;
		emittedSized.doc.head.appendChild(styleEl);
		const holder = emittedSized.doc.createElement('div');
		holder.innerHTML = emittedHtml;
		const emittedRoot = holder.firstElementChild;
		if (!emittedRoot) throw new Error('emitted markup has no root element');
		emittedSized.doc.body.appendChild(emittedRoot);

		// emitBem deep-copies the clone and only rewrites class/style attributes (never
		// adds or drops elements), so the emitted tree is structurally identical to the
		// clone tree: a lockstep zip pairs them. pairedSubtrees pairs the live original to
		// the clone (skipping clone-only injected nodes the original lacks).
		const cloneToFramed = new Map<Element, Element>();
		zip(captured.clone, framedClone, cloneToFramed);
		const cloneToEmitted = new Map<Element, Element>();
		zip(captured.clone, emittedRoot, cloneToEmitted);

		// delta B: every paired element, emitted standalone vs inline-clone standalone.
		for (const [clone, framed] of cloneToFramed) {
			const emitted = cloneToEmitted.get(clone);
			if (!emitted) continue;
			const cloneCs = cloneSized.win.getComputedStyle(framed);
			const emittedCs = emittedSized.win.getComputedStyle(emitted);
			for (const prop of comparableProps(cloneCs)) {
				const cloneVal = cloneCs.getPropertyValue(prop);
				const emittedVal = emittedCs.getPropertyValue(prop);
				if (valuesMatch(cloneVal, emittedVal)) continue;
				report.deltaB.droppedProps++;
				bCounts.set(prop, (bCounts.get(prop) ?? 0) + 1);
				if (report.deltaB.samples.length < 40) {
					report.deltaB.samples.push({ path: pathOf(captured.clone, clone), prop, a: cloneVal, b: emittedVal });
				}
			}
		}

		// delta A: every live original, live computed value vs emitted standalone. A value
		// the emitted CSS never carries is an absent-at-bake gap; one it carries but renders
		// differently is a render-time gap (the delta-B attribution says which mechanism).
		const cssHaystack = emittedCss.replace(/\s+/g, ' ').toLowerCase();
		for (const [original, clone] of pairedSubtrees(captured.root, captured.clone)) {
			const emitted = cloneToEmitted.get(clone);
			if (!emitted) continue;
			const live = getComputedStyle(original);
			const emittedCs = emittedSized.win.getComputedStyle(emitted);
			for (const prop of comparableProps(live)) {
				const liveVal = live.getPropertyValue(prop);
				const emittedVal = emittedCs.getPropertyValue(prop);
				if (valuesMatch(liveVal, emittedVal)) continue;
				report.deltaA.droppedProps++;
				aCounts.set(prop, (aCounts.get(prop) ?? 0) + 1);
				if (!cssHaystack.includes(liveVal.replace(/\s+/g, ' ').toLowerCase())) report.absentProps++;
				if (report.deltaA.samples.length < 40) {
					report.deltaA.samples.push({ path: pathOf(captured.root, original), prop, a: liveVal, b: emittedVal });
				}
			}
		}
	} catch (err) {
		captured.warnings.push(`emitted probe: skipped (${(err as Error).message})`);
	} finally {
		cloneSized?.frame.remove();
		emittedSized?.frame.remove();
	}
	report.deltaA.topProps = topN(aCounts);
	report.deltaB.topProps = topN(bCounts);
	return report;
}

/** The 20 most frequent properties from a discrepancy count map, descending. */
function topN(counts: Map<string, number>): Array<{ prop: string; count: number }> {
	return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([prop, count]) => ({ prop, count }));
}

/** Matches a number (int, decimal, or scientific) anywhere in a computed value. */
const NUMBER_TOKEN = /-?\d*\.?\d+(?:e[+-]?\d+)?/gi;

/**
 * Whether two computed values are equal up to sub-0.1px float noise. Identical strings
 * match; otherwise every embedded number is rounded to one decimal and the normalized
 * forms compared, so a benign length round-trip residual (a `px`->`rem`->`px` line-height
 * of 21.0012px vs 21.0013px, a 9999px radius vs 9999.01px) is not counted as a loss,
 * while a real divergence (a dropped declaration falling back to 0/normal/currentColor,
 * or a different color) still differs. The threshold is well below one device pixel, so
 * nothing visible is masked.
 *
 * @param a - one computed value
 * @param b - the other computed value
 */
function valuesMatch(a: string, b: string): boolean {
	if (a === b) return true;
	return a.replace(NUMBER_TOKEN, roundToTenth) === b.replace(NUMBER_TOKEN, roundToTenth);
}

/** Rounds a matched number token to one decimal place, as a string. */
function roundToTenth(token: string): string {
	const n = parseFloat(token);
	return Number.isFinite(n) ? String(Math.round(n * 10) / 10) : token;
}

/** A bake the closing reconciliation will apply: a clone element gets `prop: value`. */
interface Override {
	clone: Element;
	framed: Element;
	prop: string;
	value: string;
}

/** Max reconciliation rounds. A structural property (display) can shift descendants'
 * computed values, so the diff is run to a fixed point; in practice it converges in
 * one or two passes, and the cap guards against a pathological non-converging cycle. */
const MAX_ROUNDS = 4;

/**
 * The closing reconciliation: makes the standalone artifact's own render the source of
 * truth. For every paired element, any paint or box property whose value in the
 * standalone clone differs from the original's live computed value is corrected by
 * baking the original's resolved value, overriding an authored value that does not
 * reproduce standalone (a dangling token, a lost inherited font, an ancestor-relative
 * length). This is the single anchor that fixes missing backgrounds, dangling
 * variables, lost display, and dropped box props at once.
 *
 * It runs to a fixed point: baking a structural property such as `display` can change
 * descendants' computed values, so each round re-reads the standalone render (the
 * bakes are applied to the in-frame copy too, so the next round sees them) and stops
 * when a round makes no further corrections.
 *
 * @param captured - bakedStyles + clone are mutated in place
 */
export function reconcileStandalone(captured: Captured): void {
	try {
		withStandaloneFrame(captured, (mapCloneToFrame, win) => {
			const pairs = pairedSubtrees(captured.root, captured.clone).filter(([, clone]) => mapCloneToFrame.has(clone));
			// Snapshot each element's live computed values once; the live page never
			// changes, so this is the fixed target every round reconciles toward.
			const liveTargets = pairs.map(([original, clone]) => {
				const live = getComputedStyle(original);
				const want = new Map<string, string>();
				for (const prop of comparableProps(live)) {
					const value = live.getPropertyValue(prop);
					if (value !== '') want.set(prop, value);
				}
				return { clone, framed: mapCloneToFrame.get(clone)!, want };
			});

			for (let round = 0; round < MAX_ROUNDS; round++) {
				const overrides: Override[] = [];
				for (const { clone, framed, want } of liveTargets) {
					const standalone = win.getComputedStyle(framed);
					for (const [prop, value] of want) {
						if (standalone.getPropertyValue(prop) !== value) overrides.push({ clone, framed, prop, value });
					}
				}
				if (overrides.length === 0) break; // Converged.
				for (const o of overrides) applyOverride(captured, o);
			}
		});
		recoverEscapedBackground(captured);
		zeroRootMargin(captured);
	} catch (err) {
		captured.warnings.push(`standalone reconcile: skipped (${(err as Error).message})`);
	}
}

/**
 * Zeroes the snip root's own margin. A root margin positioned the element against
 * siblings that do not travel with the snip (escaped context, like the geometry
 * bake.ts recovers), so standalone it only pushes the component away from the origin.
 * A pasted component is positioned by its new container, not by a margin it carried
 * from the old page, so the faithful standalone form sits flush at the origin. Only the
 * root is affected; descendant margins are real intra-component spacing and are kept.
 *
 * @param captured - the root clone's baked margin is removed in place
 */
function zeroRootMargin(captured: Captured): void {
	const rootClone = captured.clone as HTMLElement;
	const baked = captured.bakedStyles.get(rootClone) ?? new Map<string, string>();
	for (const prop of ['margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left']) {
		baked.delete(prop);
		try {
			rootClone.style.removeProperty(prop);
		} catch {
			// Not removable for this element; the baked-map delete is enough.
		}
	}
	baked.set('margin', '0');
	captured.bakedStyles.set(rootClone, baked);
	try {
		rootClone.style.setProperty('margin', '0');
	} catch {
		// Invalid for this element; the baked-map entry still ships to emit.
	}
}

/**
 * Recovers the backdrop a snip lost with its ancestor chain. A component is often
 * authored with a transparent background because it sits on a section that paints the
 * color (a dark hero, a tinted band); reparented standalone, that section is gone and
 * the component renders on white, so light text vanishes. This is the same escaped-
 * context recovery bake.ts already does for geometry (bakeEscapedLayout), applied to
 * paint: when the root's own background is transparent, bake the nearest opaque
 * ancestor background-color onto it.
 *
 * Runs after the standalone reconciliation deliberately: the reconciliation makes the
 * root reproduce its OWN computed style (a transparent background), and this is the
 * separate, later decision to restore the vanished backdrop, so it is not reverted.
 * Only the root needs it; children paint over it. Color only, never an ancestor's
 * positioned background-image (which is sized for the full section, not the snip).
 *
 * @param captured - the root clone's baked map + inline style are extended
 */
function recoverEscapedBackground(captured: Captured): void {
	const rootClone = captured.clone;
	const rootCs = getComputedStyle(captured.root);
	// The root already paints its own backdrop (an opaque color or any image): trust it.
	if (!isTransparentColor(rootCs.backgroundColor)) return;
	if (rootCs.backgroundImage && rootCs.backgroundImage !== 'none') return;

	let node = captured.root.parentElement;
	while (node && node !== document.documentElement) {
		const cs = getComputedStyle(node);
		if (!isTransparentColor(cs.backgroundColor)) {
			const baked = captured.bakedStyles.get(rootClone) ?? new Map<string, string>();
			baked.set('background-color', cs.backgroundColor);
			captured.bakedStyles.set(rootClone, baked);
			try {
				(rootClone as HTMLElement).style.setProperty('background-color', cs.backgroundColor);
			} catch {
				// Invalid for this element; the baked-map entry still ships to emit.
			}
			return;
		}
		// A nearer ancestor paints its backdrop with an image (a hero photo, a gradient
		// band) rather than a solid color. That image is sized for the whole section and
		// is not in the snipped subtree, so it cannot be faithfully reproduced on the
		// component. Flag the inherent limit rather than ship a transparent element that
		// renders its light text on white.
		if (cs.backgroundImage && cs.backgroundImage !== 'none') {
			captured.warnings.push('standalone: element is transparent over an ancestor background-image not in the snip; backdrop cannot be reproduced standalone');
			return;
		}
		node = node.parentElement;
	}
}

/** Whether a computed color is fully transparent (so it paints no backdrop). */
function isTransparentColor(color: string): boolean {
	return color === 'transparent' || color === 'rgba(0, 0, 0, 0)' || /,\s*0\)\s*$/.test(color);
}

/**
 * Bakes one recovered value onto the clone (persistent: bakedStyles + inline style) and
 * mirrors it onto the in-frame copy so the next reconciliation round reads the updated
 * standalone render. A property the element rejects is skipped via the inline try/catch.
 *
 * @param captured - source of the per-clone baked maps
 * @param o - the override to apply
 */
function applyOverride(captured: Captured, o: Override): void {
	const baked = captured.bakedStyles.get(o.clone) ?? new Map<string, string>();
	baked.set(o.prop, o.value);
	captured.bakedStyles.set(o.clone, baked);
	try {
		(o.clone as HTMLElement).style.setProperty(o.prop, o.value);
	} catch {
		// Invalid for this element; the baked-map entry is still recorded for emit.
	}
	try {
		(o.framed as HTMLElement).style.setProperty(o.prop, o.value);
	} catch {
		// Mirror is best-effort; a failure only costs a redundant next-round override.
	}
}

/**
 * The longhand properties worth comparing on an element: every enumerable computed
 * longhand except custom properties (which do not enumerate) and the explicit skip
 * set. The standalone render is the authority, so this list is deliberately broad,
 * never a hand-picked "important props" set.
 *
 * @param cs - the element's computed style
 */
function comparableProps(cs: CSSStyleDeclaration): string[] {
	const out: string[] = [];
	for (let i = 0; i < cs.length; i++) {
		const prop = cs.item(i);
		if (!prop || prop.startsWith('--') || SKIP_PROPS.has(prop)) continue;
		out.push(prop);
	}
	return out;
}

/**
 * Mounts a deep copy of the working clone in a fresh, hidden, same-origin iframe
 * sized to the capture viewport (about:blank carries only the ua stylesheet, so the
 * page's author rules are absent, exactly the pasted-snip environment). Builds a map
 * from each working-clone element to its in-frame counterpart (the two trees are
 * structurally identical, so a lockstep walk pairs them), then runs `fn` with that
 * map while the frame is attached and laid out, tearing it down afterward.
 *
 * @param captured - source of the clone and the viewport size
 * @param fn - reads standalone computed styles via the clone->frame element map
 */
function withStandaloneFrame(captured: Captured, fn: (map: Map<Element, Element>, win: Window) => void): void {
	const sized = createSizedFrame(captured);
	try {
		const framedRoot = sized.doc.importNode(captured.clone, true) as Element;
		sized.doc.body.appendChild(framedRoot);
		const map = new Map<Element, Element>();
		zip(captured.clone, framedRoot, map);
		fn(map, sized.win);
	} finally {
		sized.frame.remove();
	}
}

/** A hidden iframe and its document/window, sized to the capture viewport. */
interface SizedFrame {
	frame: HTMLIFrameElement;
	doc: Document;
	win: Window;
}

/**
 * Creates a fresh, hidden, same-origin iframe sized to the capture viewport, with the
 * iframe's own ua margins zeroed so a mounted root lays out from 0,0. about:blank
 * carries only the ua stylesheet, so the page's author rules are absent, exactly the
 * pasted-snip environment. The caller mounts content into `doc.body` and must call
 * `frame.remove()` when done (both standalone renders the loop compares are built on it).
 *
 * @param captured - source of the viewport size
 */
function createSizedFrame(captured: Captured): SizedFrame {
	const vw = captured.page.viewport.width || 1280;
	const vh = captured.page.viewport.height || 800;
	const frame = document.createElement('iframe');
	frame.setAttribute('aria-hidden', 'true');
	// Off-screen but sized to the capture viewport so vw/vh/% resolve as they would
	// in the pasted snip; visibility:hidden keeps it from painting.
	frame.style.cssText = `position:absolute;left:-99999px;top:0;width:${vw}px;height:${vh}px;border:0;visibility:hidden`;
	document.body.appendChild(frame);
	const doc = frame.contentDocument;
	const win = frame.contentWindow;
	if (!doc || !win) {
		frame.remove();
		throw new Error('standalone iframe unavailable');
	}
	doc.documentElement.style.margin = '0';
	doc.body.style.margin = '0';
	return { frame, doc, win: win as unknown as Window };
}

/**
 * Walks two structurally-identical trees in lockstep, recording clone->copy pairs.
 * The frame copy is a deep importNode of the clone, so children align by index.
 *
 * @param clone - a working-clone element
 * @param framed - its in-frame counterpart
 * @param map - accumulates the element correspondence
 */
function zip(clone: Element, framed: Element, map: Map<Element, Element>): void {
	map.set(clone, framed);
	const a = clone.children;
	const b = framed.children;
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) {
		const ca = a[i];
		const cb = b[i];
		if (ca && cb) zip(ca, cb, map);
	}
}

/**
 * Counts elements present in the original subtree but SILENTLY missing from the clone.
 * Walks both trees in lockstep (skipping clone-only injected nodes, as pairedSubtrees
 * does); an original child the clone lacks at a given level is a drop, counted with its
 * whole subtree. Elements a handler removes deliberately (a `<picture>`'s `<source>`,
 * overridden by the pinned `<img src>`) are not silent drops and do not count, so this
 * stays a true signal of unintended structural loss rather than intended pruning.
 *
 * @param root - the live snip root
 * @param clone - the working clone
 */
function countDroppedElements(root: Element, clone: Element): number {
	let dropped = 0;
	const walk = (o: Element, c: Element): void => {
		const oKids = Array.from(o.children).filter((ch) => !isIntentionallyRemoved(ch));
		const cKids = Array.from(c.children).filter((ch) => !isInjected(ch));
		const n = Math.min(oKids.length, cKids.length);
		for (let i = 0; i < n; i++) {
			const ok = oKids[i];
			const ck = cKids[i];
			if (ok && ck) walk(ok, ck);
		}
		for (let i = n; i < oKids.length; i++) {
			const ok = oKids[i];
			if (ok) dropped += 1 + ok.querySelectorAll('*').length;
		}
	};
	walk(root, clone);
	return dropped;
}

/** True for an original element a handler removes by design, so its absence is not a drop. */
function isIntentionallyRemoved(el: Element): boolean {
	// images.ts removes <source> inside <picture> once the <img> is pinned to currentSrc.
	return el.tagName === 'SOURCE' && el.parentElement?.tagName === 'PICTURE';
}

/** A short positional path from the snip root to `el`, for diagnostic samples. */
function pathOf(root: Element, el: Element): string {
	const parts: string[] = [];
	let node: Element | null = el;
	while (node && node !== root.parentElement) {
		const parent: Element | null = node.parentElement;
		const idx = parent ? Array.from(parent.children).indexOf(node) : 0;
		parts.unshift(`${node.tagName.toLowerCase()}[${idx}]`);
		if (node === root) break;
		node = parent;
	}
	return parts.join('/');
}
