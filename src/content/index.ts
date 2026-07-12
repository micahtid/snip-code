/**
 * content/index.ts: pipeline orchestrator + content-script entry point
 *
 * Pipeline position: spans the whole pipeline, the conductor, not a single phase
 * Reads from Captured: constructs it in the capture phase, reads it downstream
 * Writes to Captured: owns the lifecycle
 *
 * It exists because chrome injects exactly one content script per page. This file
 * is that script. It owns the message protocol and runs the phases in order:
 *
 * capture -> content/capture/* : picker -> dom clone -> stylesheet discovery
 * reconcile -> content/reconcile/*
 * resolve -> content/resolve/*
 * convert -> content/convert/*
 * polish -> content/polish/*
 *
 * capture produces a Captured object, which the reconcile through convert phases
 * turn into clean code before it is emitted.
 */
import type { Captured } from './types';
import { ElementPicker } from './capture/picker';
import { buildElementMetadata, cloneElement } from './capture/dom';
import { settle } from './capture/settle';
import { discoverStylesheets } from './capture/sheets';
import { augmentInheritedChainViaCDP, recoverCrossOriginSheets, recoverCrossOriginFontsViaCDP } from './capture/cdp';
import { measureInteractiveStates } from './capture/states-measure';
import { detectBuilder } from './capture/gate';
import { reconcile } from './reconcile/bake';
import { denoise } from './reconcile/denoise';
import { reconcileStandalone, probeStandalone, probeEmitted } from './reconcile/standalone';
import { apply as applyIcons } from './reconcile/features/icons';
import { apply as applyFonts } from './reconcile/features/fonts';
import { apply as applyQueries } from './reconcile/features/queries';
import { apply as applyPseudo } from './reconcile/features/pseudo';
import { apply as applyStates } from './reconcile/features/states';
import { apply as applyImages } from './reconcile/features/images';
import { apply as applyShadow } from './reconcile/features/shadow';
import { apply as applyUnits } from './reconcile/features/units';
import { apply as applyColors } from './reconcile/features/colors';
import { apply as applyAnimation } from './reconcile/features/animation';
import { apply as applyEffects } from './reconcile/features/effects';
import { apply as applyLayers } from './reconcile/features/layers';
import { apply as applyTables } from './reconcile/features/tables';
import { apply as applyLists } from './reconcile/features/lists';
import { apply as applyForms } from './reconcile/features/forms';
import { resolveVariables } from './resolve/vars';
import { resolveFonts, appendGenericFallbacks, correctFontMime, mergeIdenticalFaces } from './resolve/fonts';
import { resolveAnimations } from './resolve/anim';
import { resolveTransitionTiming } from './resolve/transition';
import { inlineResources } from './resolve/inline';
import type { OutputFormat, TokenUsage } from './types';
import { emitHtml, composeDocument, type HtmlOutput } from './convert/html';
import { emitTailwind } from './convert/tailwind';
import { emitBem } from './convert/bem';
import { emitJsx } from './convert/jsx';
import { emitVue } from './convert/vue';
import { cleanCss } from './convert/clean';
import { minimizeCss, type MinimizeStats } from './minimize/prune';
import { normalizeCss } from './minimize/normalize';
import { mergeCss } from './minimize/merge';
import { purgeAtRules } from './minimize/atrules';
import { inlineVars } from './minimize/inline';
import { injectReset } from './minimize/reset';
import { foldLogical } from './minimize/logical';
import { foldTransitions } from './minimize/transitions';
import { colorizeCss } from './minimize/colorize';
import { stripUnreferencedDataAttributes } from './minimize/attributes';
import { assembleHtmlDocument, formatCss, isHtmlShaped } from './convert/format';
import { splitAssets } from './convert/assets';
import { polish } from './polish/llm';
import { buildAssistiveJson, deliver } from './assistive/emit';
import { getPrefs, storeSnippet } from '../utils/storage';
import { DEFAULT_MODELS } from '../utils/byok';
import type { Provider } from './types';
import { START_SCAN, INSPECT_RESULT, START_PICKER, CANCEL_PICKER, PICKER_SELECTED, SNIP_RESULT } from './types';
import type { InspectResult, ScanKind } from './inspect/types';
import { extractPageFonts } from './inspect/fonts';
import { extractPageAssets } from './inspect/assets';
import { extractPageColors } from './inspect/colors';
import { extractPageSchema } from './inspect/schema/extract';
import { optimizeSchema } from './inspect/schema/optimize';
import { enhanceColors, enhanceSchema } from './inspect/ai';

/**
 * The reconcile-phase feature handlers, in apply order. Each handles
 * one css/html spec mechanism universally and is orthogonal to the others.
 * Registered here, in the orchestrator, so no features/index.ts file is needed
 * outside the declared repo tree.
 */
const FEATURE_HANDLERS: Array<[string, (c: Captured) => Captured]> = [
	['icons', applyIcons],
	['fonts', applyFonts],
	['queries', applyQueries],
	['pseudo', applyPseudo],
	['states', applyStates],
	['images', applyImages],
	['shadow', applyShadow],
	['units', applyUnits],
	['colors', applyColors],
	['animation', applyAnimation],
	['effects', applyEffects],
	['layers', applyLayers],
	['tables', applyTables],
	['lists', applyLists],
	['forms', applyForms],
];

/**
 * Runs every feature handler over the captured snip, isolating failures.
 *
 * A handler that throws never halts the pipeline: the error is
 * recorded as a warning and the unmodified captured flows on. Output ships with
 * the warning, and only output divergence affects the grader.
 *
 * @param captured - the reconciled snip that handlers mutate and return
 */
function runFeatures(captured: Captured): void {
	for (const [name, fn] of FEATURE_HANDLERS) {
		try {
			fn(captured);
		} catch (err) {
			captured.warnings.push(`feature ${name} failed: ${(err as Error).message}`);
		}
	}
}

/**
 * Runs the reconcile, resolve, and self-containment transform that turns a captured
 * snip into a self-contained clone. Shared by the live pipeline (runPipeline) and the
 * headless grader path (runHeadless) so the phase order has one authoritative home:
 * adding or reordering a phase happens here, never in two places that could drift.
 */
async function runCoreTransform(captured: Captured): Promise<void> {
	// Reconcile phase. Authored and inherited styles bake onto the clone, the feature
	// handlers run over the result with isolated failures, then de-noise drops the inert
	// declarations they bake so every output format ships the smaller result.
	reconcile(captured);
	runFeatures(captured);
	denoise(captured);

	// Resolve phase. Var resolution in a single pass, @font-face absolutization,
	// @keyframes pairing. Order: vars first, which may rewrite values, then
	// fonts/keyframes which read the now-stable baked styles.
	resolveVariables(captured);
	resolveFonts(captured);
	resolveAnimations(captured);
	// Var resolution can collapse a cycled transition timing sub-list (a single-value var())
	// to one literal against a multi-entry transition-property, which would serialize to a
	// malformed `transition` shorthand. Re-expand the sub-lists so the fold stays lossless.
	resolveTransitionTiming(captured);

	// Closing reconciliation: make the standalone artifact's own render the source of
	// truth, baking the original's resolved value for any paint/box property that does
	// not reproduce standalone, such as dangling tokens, lost inherited fonts, or missing
	// backgrounds. Runs last so it corrects anything resolve left dangling.
	reconcileStandalone(captured);
	// Self-containment: guarantee every font stack ends in a generic so text never
	// falls back to the default serif when a custom font is unavailable, then inline the
	// referenced fonts and images as data uris so the artifact does not depend on the origin.
	appendGenericFallbacks(captured);
	await inlineResources(captured);
	// Post-embed font sanity: relabel each font data uri with the mime its bytes actually are,
	// then collapse faces that embed identical bytes and differ only in weight into one
	// weight-range @font-face, so a file served under several weights is carried once.
	correctFontMime(captured);
	mergeIdenticalFaces(captured);
}

/**
 * Runs the deterministic, key-free minimize pipeline over an assembled html-shaped artifact:
 * the stylesheet is reduced against its own shipped markup and the markup is stripped of the
 * data-* hooks the reduced stylesheet no longer references. Shared by the live pipeline and the
 * headless grader so the pass order has one authoritative home. Every css step degrades to its
 * input on failure, so the pipeline always produces a shippable pair.
 *
 * @param captured - source of the viewport size. Warnings are appended here on any skip
 * @param html - the assembled markup, mounted in each oracle and stripped at the end
 * @param css - the assembled stylesheet to reduce
 * @param stats - optional measurement sink, filled by the first prune pass when provided
 * @returns the stripped markup and the minimized stylesheet
 */
async function minimizeArtifact(
	captured: Captured,
	html: string,
	css: string,
	stats?: MinimizeStats,
): Promise<{ html: string; css: string }> {
	const pruned = await minimizeCss(css, captured, html, stats);
	const normalized = await normalizeCss(await foldLogical(pruned, captured, html), captured, html);
	// Drop transition layers with no state changes, then merge sees any rules the fold unified.
	const folded = foldTransitions(normalized);
	const merged = await mergeCss(folded, captured, html);
	const purged = purgeAtRules(merged);
	const inlined = purgeAtRules(await inlineVars(purged, captured, html));
	const reset = await injectReset(inlined, captured, html);
	// Only rerun prune when a reset was actually injected, to drop the restatements it made
	// redundant. A rejected reset leaves the css untouched and needs no second pass.
	const deduped = reset === inlined ? inlined : await minimizeCss(reset, captured, html);
	// Colorize first so canvas-canonical colors make any equal-color rules byte-identical, then
	// regroup once more through the merge entry point to collapse a pair colorize just unified,
	// and re-finalize since the merge's cssom parse re-serializes the hex.
	const colored = colorizeCss(formatCss(deduped));
	const finalCss = colorizeCss(formatCss(await mergeCss(colored, captured, html)));
	// Markup pass, last in minimize: drop every data-* attribute the shipped stylesheet never
	// references, the framework scope and instrumentation hooks a human would not keep.
	return { html: stripUnreferencedDataAttributes(html, finalCss), css: finalCss };
}

/** Only one picker may be active at a time. */
let activePicker: ElementPicker | null = null;

/**
 * Runs the capture phase on the chosen element, assembling the shared
 * Captured object every later phase reads.
 *
 * @param root - the live element the user picked
 * @param screenshot - cropped png data url from the picker, may be empty
 * @returns the populated Captured object
 */
async function capture(root: Element, screenshot: string): Promise<Captured> {
	// Settle first: drive the element to its revealed, loaded state before anything is
	// read or cloned, so the snip reflects what a human sees rather than a transient
	// pre-reveal frame. Runs ahead of the clone and every computed-style read below.
	const settled = await settle(root);

	const sheets = discoverStylesheets();
	const captured: Captured = {
		page: {
			url: location.href,
			title: document.title,
			viewport: {
				width: window.innerWidth,
				height: window.innerHeight,
				devicePixelRatio: window.devicePixelRatio || 1,
			},
			userAgent: navigator.userAgent,
		},
		capturedAt: new Date().toISOString(),
		element: buildElementMetadata(root),
		screenshot,
		root,
		clone: cloneElement(root),
		stylesheets: sheets.stylesheets,
		foundationRules: sheets.foundationRules,
		componentRules: sheets.componentRules,
		variables: sheets.variables,
		fonts: sheets.fonts,
		keyframes: sheets.keyframes,
		inaccessible: {
			crossOriginStylesheets: sheets.crossOriginStylesheets,
			closedShadowRoots: 0, // Cdp shadow-pierce fills this in.
		},
		bakedStyles: new Map(),
		measuredStates: null, // measureInteractiveStates fills this in. Null means not measured.
		warnings: settled.warning ? [settled.warning] : [],
	};

	// Privileged augmentation, background-mediated. Both soft-fail: the snip
	// proceeds on cssom-only data if cdp attach is refused or a fetch is blocked.
	await augmentInheritedChainViaCDP(captured); // inherited cascade via cdp
	await recoverCrossOriginSheets(captured); // Recover cors-blocked sheets by privileged re-fetch
	// Fallback for the @font-face rules the re-fetch could not get, such as when a cdn waf blocks
	// the extension origin. Read the sheet text the browser already parsed over cdp. This closes
	// the font-discovery gap cross-origin cdns leave behind the same-origin policy and bot rules.
	await recoverCrossOriginFontsViaCDP(captured);
	// Measure interactive states by forcing them live. Soft-fails to copying authored rules
	// if cdp is busy. Runs after the clone is taken, so the transient force/shim it applies
	// to the live page never reaches the artifact. Sequential with the cdp paths above, and each
	// attaches and detaches fully before the next, so the debugger is never doubly attached.
	await measureInteractiveStates(captured);

	return captured;
}

/**
 * Runs the pipeline for a selected element and ships a result to the sidebar.
 *
 * @param root - the picked element
 * @param screenshot - cropped png data url
 * @param mode - snip for code, or assistive for json
 */
async function runPipeline(root: Element, screenshot: string, mode: 'snip' | 'assistive'): Promise<void> {
	// Builder gate: refuse framer/wix/etc before doing any capture
	// work. This is a cheap structural check. On a hit we emit a static unsupported message
	// and stop, with no degraded fallback output.
	const gate = detectBuilder(root);
	if (gate.blocked) {
		shipResult({ mode, unsupported: true, builder: gate.builder, message: gate.message });
		console.info('snipcode: snip refused (builder gate)', gate.builder);
		return;
	}

	const captured = await capture(root, screenshot);

	// Assistive mode stops at capture and emits metadata json. Snip mode runs the
	// full pipeline of reconcile, resolve, convert, and polish, and emits the styled clone.
	if (mode === 'assistive') {
		// Assistive runs the capture phase only, then emits the assistive json and
		// delivers it over the user's chosen channels: clipboard, file, or webhook.
		const doc = buildAssistiveJson(captured);
		const prefs = await getPrefs();
		const deliveryWarnings = await deliver(doc, prefs);
		shipResult({ mode, json: JSON.stringify(doc, null, 2), warnings: [...captured.warnings, ...deliveryWarnings] });
		return;
	}

	// Turn the captured snip into a self-contained clone through reconcile, resolve, and
	// self-containment. See runCoreTransform for the authoritative phase order.
	await runCoreTransform(captured);

	// Convert phase. Emit the user's chosen format and run dead-code elimination
	// over the emitted stylesheet.
	const prefs = await getPrefs();
	const format: OutputFormat = prefs.defaultOutput;
	const { html, css } = emitFormat(captured, format);
	// The bem emitters, now including the html format, put their generated classes on a
	// private copy, so the cleaner must match selectors against the emitted markup, not
	// the inline-styled clone, which carries none of those classes. The tailwind/jsx/vue
	// paths keep matching against the clone, their established, render-verified behavior.
	const classMarkup = format === 'html' || format === 'bem-css' || format === 'bem-scss' ? html : undefined;
	let cleanedCss = cleanCss(css, captured, classMarkup);
	let finalHtml = html;
	// Token usage from the polish call, the only billed step, shipped so the panel
	// can total it for the session. Undefined when polish is skipped or has no key.
	let usage: TokenUsage | undefined;
	let output: string;

	// For the html-shaped formats, assemble the shipped artifact first (lift the injected
	// pseudo and state styles into the head, re-key their markers to real class selectors,
	// pretty-print markup and css), then run the deterministic minimize pipeline over that
	// shipped stylesheet, and only then the optional byok polish, so the model sees the small,
	// clean, final css and its naming edits land last. jsx/vue self-indent and just compose.
	if (isHtmlShaped(format)) {
		const assembled = assembleHtmlDocument(html, cleanedCss, captured.warnings);
		finalHtml = assembled.html;
		cleanedCss = assembled.css;

		// Minimize phase, deterministic and key-free, class-based formats only. See
		// minimizeArtifact for the authoritative pass order.
		if (classMarkup !== undefined) {
			const minimized = await minimizeArtifact(captured, assembled.html, assembled.css);
			finalHtml = minimized.html;
			cleanedCss = minimized.css;
		}

		// Polish phase, byok and optional, class-based formats only. Semantic class renames,
		// tags, and grouping comments from the user's own llm. Silently no-ops without a key,
		// and reverts to the pre-polish output if an edit changes the render.
		if (classMarkup !== undefined) {
			const model = prefs.modelOverrides[prefs.activeProvider] ?? DEFAULT_MODELS[prefs.activeProvider];
			const polished = await polish(captured, finalHtml, cleanedCss, prefs.activeProvider, model);
			finalHtml = polished.html;
			cleanedCss = polished.css;
			usage = polished.usage;
			if (polished.warning) captured.warnings.push(polished.warning);
		}
		output = composeDocument(finalHtml, cleanedCss);
	} else {
		output = composeDocument(finalHtml, cleanedCss);
	}

	// Delivery split: for the self-contained html-shaped output, lift the inline svgs
	// and data-uri images into their own referenced files so the panel can show them as
	// switchable tabs. `output`, the inlined document, is kept for preview and storage.
	const files = isHtmlShaped(format) ? splitAssets(output, captured.warnings) : undefined;
	shipResult({ mode, format, html: finalHtml, css: cleanedCss, output, files, warnings: captured.warnings, usage });

	// Persist the snippet, fifo and capped at 50. Best-effort, so a storage failure
	// never fails the snip.
	void storeSnippet({
		id: crypto.randomUUID(),
		capturedAt: captured.capturedAt,
		page: captured.page,
		element: captured.element,
		output: { format, html: finalHtml, css: cleanedCss },
		screenshot: captured.screenshot,
	}).catch(() => {});
	console.info('snipcode: snip complete');
}

/**
 * Dispatches to the emitter for the chosen output format. Every
 * format is a pure transform of the same Captured, so all 7 are derivable from
 * one capture without re-running the capture phase.
 *
 * @param captured - the reconciled+resolved snip
 * @param format - the output format to emit
 */
function emitFormat(captured: Captured, format: OutputFormat): HtmlOutput {
	switch (format) {
		case 'tailwind':
			return emitTailwind(captured);
		case 'html':
		case 'bem-css':
			// The html format ships a self-contained document with semantic bem classes
			// and a stylesheet, not inline styles, the most readable single-file output.
			// The legacy bem-css value resolves here too, so older snippets still emit.
			return emitBem(captured, false);
		case 'bem-scss':
			return emitBem(captured, true);
		case 'jsx-tailwind':
			return emitJsx(captured, 'tailwind');
		case 'jsx-css':
			return emitJsx(captured, 'css');
		case 'vue':
			return emitVue(captured);
		default:
			// Inline-styled html: no longer user-selectable, since the html format emits bem
			// above, and no longer graded separately, kept as the safe fallback emitter.
			return emitHtml(captured);
	}
}

/**
 * Sends a snip result to the sidebar, where the ResultPanel renders it. The
 * sidebar may be closed, so a delivery failure is swallowed and the snip still
 * succeeded.
 */
function shipResult(payload: Record<string, unknown>): void {
	chrome.runtime
		.sendMessage({ type: SNIP_RESULT, requestId: crypto.randomUUID(), payload })
		.catch(() => {});
}

/**
 * Runs one page-scoped inspector and ships its result to the sidebar. Each
 * inspector reads the live dom directly, with no element pick and no screenshot. A hard
 * failure is isolated here: an empty result of the right kind ships with the cause
 * as a warning, so the panel renders something rather than nothing.
 *
 * @param scan - which inspector to run
 */
async function runScan(scan: ScanKind): Promise<void> {
	const warnings: string[] = [];
	try {
		const { payload, usage } = await buildScan(scan, warnings);
		shipInspect(payload, usage);
	} catch (err) {
		warnings.push(`scan failed: ${(err as Error).message}`);
		shipInspect(emptyResult(scan, warnings));
	}
}

/**
 * Builds the result for one scan. Colors and schema run the optional byok ai
 * pass inline before shipping. It skips silently without a key, mirroring how
 * polish runs inline in a snip. The ai pass merges onto the raw extraction and
 * reports any configured-key failure as a warning plus its billed token usage.
 */
async function buildScan(scan: ScanKind, warnings: string[]): Promise<{ payload: InspectResult; usage?: TokenUsage }> {
	switch (scan) {
		case 'fonts':
			return { payload: { kind: 'fonts', fonts: extractPageFonts(), warnings } };
		case 'assets':
			return { payload: { kind: 'assets', assets: extractPageAssets(), warnings } };
		case 'colors': {
			const { colors, cssVariables } = extractPageColors();
			const { provider, model } = await activeModel();
			const enhanced = await enhanceColors(colors, cssVariables, provider, model);
			if (enhanced.warning) warnings.push(enhanced.warning);
			const payload: InspectResult = { kind: 'colors', colors: enhanced.colors, aiEnhanced: enhanced.aiEnhanced, warnings };
			return enhanced.usage ? { payload, usage: enhanced.usage } : { payload };
		}
		case 'schema': {
			const rawJson = JSON.stringify(optimizeSchema(extractPageSchema()), null, 2);
			const { provider, model } = await activeModel();
			const enhanced = await enhanceSchema(rawJson, provider, model);
			if (enhanced.warning) warnings.push(enhanced.warning);
			const payload: InspectResult = { kind: 'schema', json: enhanced.json, aiEnhanced: enhanced.aiEnhanced, warnings };
			return enhanced.usage ? { payload, usage: enhanced.usage } : { payload };
		}
	}
}

/** An empty result of the given kind, used when an inspector fails hard. */
function emptyResult(scan: ScanKind, warnings: string[]): InspectResult {
	switch (scan) {
		case 'fonts':
			return { kind: 'fonts', fonts: [], warnings };
		case 'assets':
			return { kind: 'assets', assets: [], warnings };
		case 'colors':
			return { kind: 'colors', colors: [], aiEnhanced: false, warnings };
		case 'schema':
			return { kind: 'schema', json: '', aiEnhanced: false, warnings };
	}
}

/** The active byok provider and resolved model, override or default, from prefs. */
async function activeModel(): Promise<{ provider: Provider; model: string }> {
	const prefs = await getPrefs();
	return { provider: prefs.activeProvider, model: prefs.modelOverrides[prefs.activeProvider] ?? DEFAULT_MODELS[prefs.activeProvider] };
}

/**
 * Ships a page-scan result to the sidebar, where InspectPanel renders it. Like a snip
 * result, the sidebar may be closed, so a delivery failure is swallowed. The
 * optional token usage rides alongside so the panel can total it for the session.
 */
function shipInspect(payload: InspectResult, usage?: TokenUsage): void {
	const body = usage ? { ...payload, usage } : payload;
	chrome.runtime
		.sendMessage({ type: INSPECT_RESULT, requestId: crypto.randomUUID(), payload: body })
		.catch(() => {});
}

/** Start the picker overlay. On select, run the pipeline for the chosen mode. */
function startPicker(mode: 'snip' | 'assistive'): void {
	activePicker?.deactivate();
	activePicker = new ElementPicker({
		onSelect: (element, screenshot) => {
			activePicker = null;
			// Selection is done and the pipeline is starting, so tell the panel to drop the
			// cancellable "Selecting" label. A closed panel is fine, hence the swallowed catch.
			chrome.runtime.sendMessage({ type: PICKER_SELECTED }).catch(() => {});
			void runPipeline(element, screenshot, mode);
		},
		onCancel: () => {
			activePicker = null;
		},
	});
	activePicker.activate();
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, _sendResponse) => {
	const type = typeof message === 'object' && message !== null && 'type' in message ? (message as { type: unknown }).type : null;
	if (type === START_PICKER) {
		const mode = (message as { mode?: unknown }).mode === 'assistive' ? 'assistive' : 'snip';
		startPicker(mode);
	} else if (type === START_SCAN) {
		const scan = (message as { scan?: unknown }).scan;
		if (scan === 'fonts' || scan === 'colors' || scan === 'assets' || scan === 'schema') void runScan(scan);
	} else if (type === CANCEL_PICKER) {
		// Panel-side esc: tear the overlay down. The panel already cleared its own
		// picking state, so no onCancel callback is needed here.
		activePicker?.deactivate();
		activePicker = null;
	}
	// No async response from the picker path, so keep the channel synchronous.
	return false;
});

// ---------------------------------------------------------------------------
// Headless test bridge for tests/run-pipeline.mjs, the HEADLESS_SNIP entry point.
// The grader drives a snip by css selector instead of the picker.
// Page and content script share the document but live in separate js worlds, so
// chrome.runtime messages and window.postMessage do not reach the page, but a
// CustomEvent dispatched on `document` does. The runner waits on
// data-snip-injected, dispatches "snip-runner:snip" {selector, mode}, and reads
// the reply on "snip-extension:result".
// ---------------------------------------------------------------------------
document.documentElement.setAttribute('data-snip-injected', '1');

document.addEventListener('snip-runner:snip', (ev) => {
	const detail = (ev as CustomEvent).detail ?? {};
	const selector = String(detail.selector ?? '');
	const mode: 'snip' | 'assistive' = detail.mode === 'assistive' ? 'assistive' : 'snip';
	void runHeadless(selector, mode).then((result) => {
		document.dispatchEvent(new CustomEvent('snip-extension:result', { detail: result }));
	});
});

/**
 * Runs the full pipeline for a selector, with no picker and no screenshot, and returns a
 * self-contained output.html string. This is the deterministic path the grader
 * measures. The byok llm polish phase is intentionally not run here.
 *
 * @param selector - css selector for the element to snip
 * @param mode - snip for code, or assistive for json
 */
async function runHeadless(selector: string, mode: 'snip' | 'assistive'): Promise<Record<string, unknown>> {
	try {
		const el = document.querySelector(selector);
		if (!el) return { ok: false, error: `selector matched 0 elements: ${selector}` };

		const gate = detectBuilder(el);
		if (gate.blocked) return { ok: true, status: 'unsupported', warnings: [gate.message] };

		const captured = await capture(el, '');
		if (mode === 'assistive') {
			// Headless assistive: emit the assistive json with no delivery side effects.
			return { ok: true, status: 'ok', assistive: buildAssistiveJson(captured), warnings: captured.warnings };
		}

		await runCoreTransform(captured);
		// Completeness probe, read-only: diff the reconciled clone's standalone render
		// against the live original. After the reconciliation this should be near zero.
		// A residual is the deterministic, drift-free signal of what still fails to
		// reproduce. It mutates nothing.
		const probe = await probeStandalone(captured);
		// Emit the bem class-based output the default html format ships, deterministically.
		// The byok polish phase stays out, so the classes are the generated block__tag-n names,
		// which are irrelevant to rendering. Assemble it the same way the sidebar does: lift pseudo
		// styles into one stylesheet, pretty-print markup + css, compose, then the grader
		// scores it as output.html. The inline-styled emitter rendered identically once the
		// css cleaner landed, so it is no longer emitted as a separate reference.
		const bem = emitFormat(captured, 'bem-css');
		const cleanedCss = cleanCss(bem.css, captured, bem.html);
		// Assemble the shipped artifact first: lift the injected pseudo styles into the head,
		// re-key them to classes, pretty-print markup and css, and compose. The minimizer then
		// runs on this shipped stylesheet in the shipped markup, so its render oracle sees the
		// exact cascade that ships rather than the pre-assembly clone, which renders the
		// injected pseudo styles and data-snip markers differently.
		const assembled = assembleHtmlDocument(bem.html, cleanedCss, captured.warnings);
		const finalHtml = assembled.html;
		// Minimize phase, deterministic and key-free. htmlBaseline is the pre-minimize shipped
		// document from this same capture, so the harness can pixel-compare pre against post
		// minimization with no live-capture drift between them. See minimizeArtifact for the
		// pass order. The grader threads a stats sink through it to report declaration counts.
		const htmlBaseline = assembled.document;
		const minimizeStats: MinimizeStats = { ms: 0, declsBefore: 0, declsAfter: 0, charsBefore: 0, charsAfter: 0 };
		const minimized = await minimizeArtifact(captured, assembled.html, assembled.css, minimizeStats);
		const finalCss = minimized.css;
		const strippedHtml = minimized.html;
		const finalDoc = composeDocument(strippedHtml, finalCss);

		// Emitted-artifact probe, read-only: diff the shipped BEM artifact's own
		// standalone render against the live original, delta A, and the inline-clone
		// render, delta B. This classifies each residual as an emit-cascade loss, delta B,
		// an absent-at-bake gap where delta A is absent from the css, or another render-time
		// mechanism. Measured on the markup and css that actually ship.
		const emittedProbe = probeEmitted(captured, finalHtml, finalCss);

		// Delivery split, the same one the sidebar ships: lift inline svgs and data-uri
		// images into their own referenced files so the training data exercises the split
		// path users see. The inlined finalDoc is still returned as html for grading.
		const files = splitAssets(finalDoc, captured.warnings);

		return {
			ok: true,
			status: 'ok',
			html: finalDoc,
			htmlBaseline,
			files,
			probe,
			emittedProbe,
			minimize: minimizeStats,
			warnings: captured.warnings,
		};
	} catch (err) {
		return { ok: false, error: (err as Error).message };
	}
}

export {};
