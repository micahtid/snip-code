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
import type { Captured, FontFace } from '../types';
import { pairedSubtrees, isInjected } from './match';

/** The result of diffing the standalone clone against the live original. */
export interface StandaloneReport {
	/** Total property discrepancies across all paired elements. */
	droppedProps: number;
	/** Elements present in the original subtree but missing from the clone. */
	droppedEls: number;
	/**
	 * Web faces the live subtree renders that the standalone artifact cannot resolve: a
	 * family absent from the artifact (discovery gap) or a declared face whose bytes
	 * never load (inlining gap). This is the resource-loss signal getComputedStyle is
	 * blind to, since both live and standalone report the same requested font string
	 * while only the live element actually paints it.
	 */
	unresolvedResources: number;
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
 * The box-size exclusion is narrowed for replaced elements (see REPLACED_BOX_PROPS):
 * their box is intrinsic or declared, never derived from in-flow content, so a size
 * divergence there is a lost size, not benign reflow.
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
 * The box-size longhands within SKIP_PROPS. These are skipped for an ordinary in-flow
 * box (its used size re-derives from the box model standalone) but compared for a
 * replaced element, whose rendered size is the authority: an inline svg with only a
 * viewBox has no intrinsic size and collapses standalone, a raster image free-sizes to
 * its intrinsic geometry and loses the display box its container imposed. Margins and
 * insets stay skipped for everyone; only the element's own size is reclaimed.
 */
const REPLACED_BOX_PROPS = new Set<string>([
	'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
	'inline-size', 'block-size', 'min-inline-size', 'min-block-size', 'max-inline-size', 'max-block-size',
]);

/**
 * Replaced elements, whose box comes from intrinsic content or an explicit dimension
 * rather than in-flow layout. Their standalone size must equal live, so the comparison
 * reclaims their box-size props. svg reports a lowercase tagName; html elements report
 * uppercase, so the test case-folds.
 */
const REPLACED_TAGS = new Set<string>(['svg', 'img', 'canvas', 'video', 'iframe', 'object', 'embed']);

function isReplacedElement(el: Element): boolean {
	return REPLACED_TAGS.has(el.tagName.toLowerCase());
}

/**
 * Reports the standalone-vs-live discrepancies without mutating anything. This is the
 * completeness instrument: it measures exactly what the artifact fails to reproduce,
 * independent of any live rendering. Alongside the computed-style diff it runs the
 * resource probe (probeUnresolvedFonts), which sees the layer below computed style that
 * the string compare cannot: a web font the artifact declares but cannot load.
 *
 * @param captured - the reconciled capture (read-only here)
 */
export async function probeStandalone(captured: Captured): Promise<StandaloneReport> {
	const report: StandaloneReport = { droppedProps: 0, droppedEls: 0, unresolvedResources: 0, topProps: [], samples: [] };
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
				for (const prop of comparableProps(live, original)) {
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
	// Resource probe: detection only, isolated so a failure leaves the count at zero and
	// never pushes a warning, keeping the emitted artifact byte-identical.
	try {
		report.unresolvedResources = await probeUnresolvedFonts(captured);
	} catch {
		// FontFaceSet or frame unavailable; the resource signal reads zero this run.
	}
	report.topProps = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([prop, count]) => ({ prop, count }));
	return report;
}

/** One web face the live subtree renders, normalized for a FontFaceSet.load() request. */
interface RenderedFace {
	family: string;
	weight: string; // Numeric css weight from computed style (e.g. "400", "700").
	style: string; // 'normal' | 'italic' | 'oblique'.
}

/**
 * Counts the web faces the standalone artifact fails to resolve. Builds an isolated
 * frame carrying only the snip's own captured @font-face rules (the exact faces the
 * artifact ships), then for each web face the live subtree renders asks the frame's
 * FontFaceSet to load it. An empty result means the family is absent from the artifact
 * (a discovery gap); a rejection or an unloaded face means a declared face could not be
 * fetched (an inlining gap). Either way the artifact would render the wrong font, so it
 * is counted. Nothing is mutated and no emitted byte changes.
 *
 * Scope is the live FontFaceSet: only families the page actually loaded as a web font
 * are checked, so correctly-rendered system and generic text (Arial, system-ui) is
 * never counted, with no family list anywhere.
 *
 * Determinism note: while a captured face still carries an external src, the frame's
 * load() reaches the network, so the count is fully deterministic only once faces are
 * inlined as data uris (resolve/inline.ts). The discovery gap (zero faces for a rendered
 * family) reads the same offline or online.
 *
 * @param captured - the reconciled capture (read-only)
 */
async function probeUnresolvedFonts(captured: Captured): Promise<number> {
	const webFamilies = liveWebFontFamilies();
	if (webFamilies.size === 0) return 0;
	const faces = renderedWebFaces(captured.root, webFamilies);
	if (faces.length === 0) return 0;

	const sized = createSizedFrame(captured);
	try {
		if (captured.fonts.length > 0) {
			const style = sized.doc.createElement('style');
			style.textContent = captured.fonts.map(fontFaceRule).join('\n');
			sized.doc.head.appendChild(style);
		}
		let unresolved = 0;
		for (const face of faces) {
			if (!(await faceResolves(sized.win, face))) unresolved++;
		}
		return unresolved;
	} finally {
		sized.frame.remove();
	}
}

/**
 * The web-font families the live page actually loaded, lowercased. A family is a web
 * font when the live document's FontFaceSet holds a face for it; system and generic
 * families never appear there, so they fall out without being named. This scopes the
 * resolution check to the fonts the snip is responsible for carrying.
 */
function liveWebFontFamilies(): Set<string> {
	const out = new Set<string>();
	try {
		document.fonts.forEach((face) => {
			const family = face.family.replace(/^["']|["']$/g, '').trim().toLowerCase();
			if (family) out.add(family);
		});
	} catch {
		// FontFaceSet unavailable; treat the page as carrying no web fonts.
	}
	return out;
}

/**
 * The distinct (family, weight, style) web faces the live subtree renders. Reads the
 * first family of each element's computed font stack (the one that actually renders),
 * paired with the weight and style it renders at, keeping only families the live page
 * loaded as a web font. Deduped so each face is counted once.
 *
 * @param root - the live snip root
 * @param webFamilies - lowercased families from the live FontFaceSet
 */
function renderedWebFaces(root: Element, webFamilies: Set<string>): RenderedFace[] {
	const seen = new Set<string>();
	const out: RenderedFace[] = [];
	for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
		const cs = getComputedStyle(el);
		const family = (cs.fontFamily.split(',')[0] ?? '').replace(/^["']|["']$/g, '').trim();
		if (!family || !webFamilies.has(family.toLowerCase())) continue;
		const rawStyle = cs.fontStyle || 'normal';
		const style = rawStyle.startsWith('italic') ? 'italic' : rawStyle.startsWith('oblique') ? 'oblique' : 'normal';
		const weight = cs.fontWeight || '400';
		const key = `${family.toLowerCase()}|${weight}|${style}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ family, weight, style });
	}
	return out;
}

/** Whether the frame's FontFaceSet resolves a face: false on an empty match or load failure. */
async function faceResolves(win: Window, face: RenderedFace): Promise<boolean> {
	try {
		const request = `${face.weight} ${face.style} 16px "${face.family.replace(/"/g, '\\"')}"`;
		const loaded = await win.document.fonts.load(request);
		return loaded.length > 0 && loaded.every((f) => f.status === 'loaded');
	} catch {
		return false;
	}
}

/** Serializes a captured face back to an @font-face rule for injection into the probe frame. */
function fontFaceRule(font: FontFace): string {
	const descriptors = Object.entries(font.descriptors).map(([prop, value]) => `${prop}:${value};`).join('');
	return `@font-face{font-family:"${font.family.replace(/"/g, '\\"')}";src:${font.src};${descriptors}}`;
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
			for (const prop of comparableProps(cloneCs, clone)) {
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
			for (const prop of comparableProps(live, original)) {
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
				for (const prop of comparableProps(live, original)) {
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
 * Only the root needs it; children paint over it. The recovered paint is a solid color,
 * or any reproducible backdrop image (a gradient, a tiled pattern, a cover/contain
 * image); a positioned framed photo, sized for the full section, is still only flagged.
 *
 * @param captured - the root clone's baked map + inline style are extended
 */
function recoverEscapedBackground(captured: Captured): void {
	const rootCs = getComputedStyle(captured.root);
	// The root already paints its own backdrop (an opaque color or any image): trust it.
	if (!isTransparentColor(rootCs.backgroundColor)) return;
	if (rootCs.backgroundImage && rootCs.backgroundImage !== 'none') return;

	let node = captured.root.parentElement;
	while (node && node !== document.documentElement) {
		const cs = getComputedStyle(node);
		if (!isTransparentColor(cs.backgroundColor)) {
			bakeOnRoot(captured, 'background-color', cs.backgroundColor);
			return;
		}
		// A nearer ancestor paints its backdrop with an image rather than a solid color.
		// A reproducible backdrop (a gradient, a repeated tile, a cover/contain image) is a
		// paint that re-renders at any size, so baking the whole multi-layer value plus its
		// placement onto the root reproduces the backdrop and makes light-on-backdrop text
		// visible, even though it was authored for the whole section. A positioned framed
		// photo is sized for that section and cannot be reproduced; that residual is flagged.
		if (cs.backgroundImage && cs.backgroundImage !== 'none') {
			if (isReproducibleBackdrop(node, cs)) {
				const place = backdropPlacement(cs);
				bakeOnRoot(captured, 'background-image', cs.backgroundImage);
				bakeOnRoot(captured, 'background-size', place.size);
				bakeOnRoot(captured, 'background-repeat', place.repeat);
				bakeOnRoot(captured, 'background-position', cs.backgroundPosition);
				return;
			}
			captured.warnings.push('standalone: element is transparent over an ancestor positioned background-image not in the snip; backdrop cannot be reproduced standalone');
			return;
		}
		node = node.parentElement;
	}
}

/** Bakes one recovered value onto the snip root (bakedStyles + inline style). */
function bakeOnRoot(captured: Captured, prop: string, value: string): void {
	const rootClone = captured.clone as HTMLElement;
	const baked = captured.bakedStyles.get(rootClone) ?? new Map<string, string>();
	baked.set(prop, value);
	captured.bakedStyles.set(rootClone, baked);
	try {
		rootClone.style.setProperty(prop, value);
	} catch {
		// Invalid for this element; the baked-map entry still ships to emit.
	}
}

/** Whether a computed color is fully transparent (so it paints no backdrop). */
function isTransparentColor(color: string): boolean {
	return color === 'transparent' || color === 'rgba(0, 0, 0, 0)' || /,\s*0\)\s*$/.test(color);
}

/**
 * Whether a computed backdrop reproduces faithfully when baked onto the snip's own,
 * smaller box. A value with no raster layer is judged on its gradients (a paint function
 * reproduces at any size). A raster layer reproduces when it tiles (a repeat fills any
 * box), scales (a cover/contain image fits any box), or paints the whole ancestor box
 * (a full-bleed backdrop, which can be rescaled to cover the snip). A smaller placed
 * raster is a framed image positioned for its section and does not reproduce.
 *
 * @param node - the ancestor painting the backdrop (source of its box size)
 * @param cs - the ancestor's computed style (image plus its placement)
 */
function isReproducibleBackdrop(node: Element, cs: CSSStyleDeclaration): boolean {
	if (!/url\(/i.test(cs.backgroundImage)) return isReproducibleGradient(cs.backgroundImage);
	return backdropTiles(cs.backgroundRepeat) || backdropScales(cs.backgroundSize) || isFullBleed(node, cs.backgroundSize);
}

/**
 * The size and repeat to bake when reproducing a backdrop on the snip. A tiled or
 * scaling backdrop keeps its own placement (a tile repeats, a cover/contain image fits).
 * A full-bleed raster sized in fixed pixels for the original section is rescaled to
 * cover, so it fills the smaller snip box rather than overflowing it.
 *
 * @param cs - the ancestor's computed style
 */
function backdropPlacement(cs: CSSStyleDeclaration): { size: string; repeat: string } {
	const keepsOwn = !/url\(/i.test(cs.backgroundImage) || backdropTiles(cs.backgroundRepeat) || backdropScales(cs.backgroundSize);
	if (keepsOwn) return { size: cs.backgroundSize, repeat: cs.backgroundRepeat };
	return { size: 'cover', repeat: 'no-repeat' };
}

/** Whether any background-repeat layer tiles (so the backdrop fills an arbitrary box). */
function backdropTiles(backgroundRepeat: string): boolean {
	return backgroundRepeat.split(',').some((layer) => {
		const r = layer.trim();
		return r !== 'no-repeat' && /repeat|round|space/i.test(r);
	});
}

/** Whether any background-size layer scales the image to its box (cover or contain). */
function backdropScales(backgroundSize: string): boolean {
	return /\b(?:cover|contain)\b/i.test(backgroundSize);
}

/**
 * Whether the first background-size layer paints the full width of the ancestor box, the
 * mark of a decorative full-bleed backdrop rather than a smaller placed image. A
 * percentage of 100 or more, or a length at least as wide as the box, is full-bleed; an
 * auto or smaller size is a placed image.
 *
 * @param node - the ancestor painting the backdrop
 * @param backgroundSize - the ancestor's computed background-size
 */
function isFullBleed(node: Element, backgroundSize: string): boolean {
	const first = (backgroundSize.split(',')[0] ?? '').trim().split(/\s+/)[0] ?? '';
	if (first.endsWith('%')) return parseFloat(first) >= 100;
	if (first.endsWith('px')) return parseFloat(first) >= (node.clientWidth || 0) * 0.95;
	return false;
}

/**
 * Whether a computed background-image is purely css gradients (linear/radial/conic,
 * including repeating and -webkit- forms). A gradient is a paint function, not positioned
 * pixels, so baking it onto a smaller box still renders a faithful backdrop.
 *
 * @param backgroundImage - the computed background-image value
 */
function isReproducibleGradient(backgroundImage: string): boolean {
	if (/url\(/i.test(backgroundImage)) return false; // A raster layer cannot be reproduced.
	return /(?:^|[\s,])(?:-webkit-|-moz-|-o-)?(?:repeating-)?(?:linear|radial|conic)-gradient\(/i.test(backgroundImage);
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
 * never a hand-picked "important props" set. A replaced element reclaims its box-size
 * props from the skip set, because for it the rendered size is authoritative.
 *
 * @param cs - the element's computed style
 * @param el - the element, used to decide whether its box size is authoritative
 */
function comparableProps(cs: CSSStyleDeclaration, el: Element): string[] {
	const boxAuthoritative = isReplacedElement(el);
	const out: string[] = [];
	for (let i = 0; i < cs.length; i++) {
		const prop = cs.item(i);
		if (!prop || prop.startsWith('--')) continue;
		if (SKIP_PROPS.has(prop) && !(boxAuthoritative && REPLACED_BOX_PROPS.has(prop))) continue;
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
