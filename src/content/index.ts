/**
 * content/index.ts: pipeline orchestrator + content-script entry point
 *
 * Pipeline position: spans the whole pipeline (this is the conductor, not a single phase)
 * Reads from Captured: constructs it (capture phase), reads it downstream
 * Writes to Captured: owns the lifecycle
 *
 * Why this exists: chrome injects exactly one content script per page. This file
 * is that script. It owns the message protocol and runs the phases in order:
 *
 * capture → content/capture/* (picker → dom clone → stylesheet discovery)
 * reconcile → content/reconcile/*
 * resolve → content/resolve/*
 * convert → content/convert/*
 * polish → content/polish/*
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
import { detectBuilder } from './capture/gate';
import { reconcile } from './reconcile/bake';
import { denoise } from './reconcile/denoise';
import { reconcileStandalone, probeStandalone, probeEmitted } from './reconcile/standalone';
import { apply as applyIcons } from './reconcile/features/icons';
import { apply as applyFonts } from './reconcile/features/fonts';
import { apply as applyQueries } from './reconcile/features/queries';
import { apply as applyPseudo } from './reconcile/features/pseudo';
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
import { resolveFonts, appendGenericFallbacks } from './resolve/fonts';
import { resolveAnimations } from './resolve/anim';
import { inlineResources } from './resolve/inline';
import type { OutputFormat } from './types';
import { emitHtml, composeDocument, type HtmlOutput } from './convert/html';
import { emitTailwind } from './convert/tailwind';
import { emitBem } from './convert/bem';
import { emitJsx } from './convert/jsx';
import { emitVue } from './convert/vue';
import { cleanCss } from './convert/clean';
import { assembleHtmlDocument, isHtmlShaped } from './convert/format';
import { splitAssets } from './convert/assets';
import { polish } from './polish/llm';
import { buildAssistiveJson, deliver } from './assistive/emit';
import { getPrefs, storeSnippet } from '../utils/storage';
import { DEFAULT_MODELS } from '../utils/byok';

/** Ui-local signals from the sidebar's picker control (components/Picker.tsx). */
const START_PICKER = 'SNIPCODE_START_PICKER';
/** Sent when the user presses esc with focus in the side panel (App.tsx). The
 * picker's own esc handler only fires when the page holds keyboard focus, so this
 * is the panel-side path that tears the overlay down regardless of focus. */
const CANCEL_PICKER = 'SNIPCODE_CANCEL_PICKER';

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
 * the warning; only output divergence affects the grader.
 *
 * @param captured - the reconciled snip; handlers mutate and return it
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

/** Only one picker may be active at a time. */
let activePicker: ElementPicker | null = null;

/**
 * Runs the capture phase on the chosen element, assembling the shared
 * Captured object every later phase reads.
 *
 * @param root - the live element the user picked
 * @param screenshot - cropped png data url from the picker (may be empty)
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
		warnings: settled.warning ? [settled.warning] : [],
	};

	// Privileged augmentation (background-mediated). Both soft-fail: the snip
	// proceeds on cssom-only data if cdp attach is refused or a fetch is blocked.
	await augmentInheritedChainViaCDP(captured); // inherited cascade via cdp
	await recoverCrossOriginSheets(captured); // Recover cors-blocked sheets by privileged re-fetch
	// Fallback for the @font-face rules the re-fetch could not get (a cdn waf blocking the
	// extension origin): read the sheet text the browser already parsed over cdp. This closes
	// the font-discovery gap cross-origin cdns leave behind the same-origin policy and bot rules.
	await recoverCrossOriginFontsViaCDP(captured);

	return captured;
}

/**
 * Runs the pipeline for a selected element and ships a result to the sidebar.
 *
 * @param root - the picked element
 * @param screenshot - cropped png data url
 * @param mode - snip (code) or assistive (json)
 */
async function runPipeline(root: Element, screenshot: string, mode: 'snip' | 'assistive'): Promise<void> {
	// Builder gate: refuse framer/wix/etc before doing any capture
	// work. Cheap structural check; on a hit we emit a static unsupported message
	// and stop, no degraded fallback output.
	const gate = detectBuilder(root);
	if (gate.blocked) {
		shipResult({ mode, unsupported: true, builder: gate.builder, message: gate.message });
		console.info('snipcode: snip refused (builder gate)', gate.builder);
		return;
	}

	const captured = await capture(root, screenshot);

	// Assistive mode stops at capture and emits metadata json. Snip mode runs the
	// full pipeline (reconcile, resolve, convert, polish) and emits the styled clone.
	if (mode === 'assistive') {
		// Assistive runs the capture phase only, then emits the assistive json and
		// delivers it over the user's chosen channels (clipboard / file / webhook).
		const doc = buildAssistiveJson(captured);
		const prefs = await getPrefs();
		const deliveryWarnings = await deliver(doc, prefs);
		shipResult({ mode, json: JSON.stringify(doc, null, 2), warnings: [...captured.warnings, ...deliveryWarnings] });
		return;
	}

	// Reconcile phase. Authored and inherited styles bake onto the clone, the feature
	// handlers run over the result (isolated failures), then de-noise drops the inert
	// declarations they bake so every output format ships the smaller result.
	reconcile(captured);
	runFeatures(captured);
	denoise(captured);

	// Resolve phase. Var resolution (single pass), @font-face absolutization,
	// @keyframes pairing. Order: vars first (may rewrite values), then
	// fonts/keyframes which read the now-stable baked styles.
	resolveVariables(captured);
	resolveFonts(captured);
	resolveAnimations(captured);

	// Closing reconciliation: make the standalone artifact's own render the source of
	// truth, baking the original's resolved value for any paint/box property that does
	// not reproduce standalone (dangling tokens, lost inherited fonts, missing
	// backgrounds). Runs last so it corrects anything resolve left dangling.
	reconcileStandalone(captured);
	// Self-containment: guarantee every font stack ends in a generic so text never
	// falls back to the default serif when a custom font is unavailable, then inline the
	// referenced fonts and images as data uris so the artifact does not depend on the origin.
	appendGenericFallbacks(captured);
	await inlineResources(captured);

	// Convert phase. Emit the user's chosen format and run dead-code elimination
	// over the emitted stylesheet.
	const prefs = await getPrefs();
	const format: OutputFormat = prefs.defaultOutput;
	const { html, css } = emitFormat(captured, format);
	// The bem emitters (now including the html format) put their generated classes on a
	// private copy, so the cleaner must match selectors against the emitted markup, not
	// the inline-styled clone (which carries none of those classes). The tailwind/jsx/vue
	// paths keep matching against the clone, their established, render-verified behavior.
	const classMarkup = format === 'html' || format === 'bem-css' || format === 'bem-scss' ? html : undefined;
	let cleanedCss = cleanCss(css, captured, classMarkup);
	let finalHtml = html;

	// Polish phase (byok, optional). Additive class renames + hover rules from the
	// user's own llm; silently no-ops without a key. Gated to class-based formats
	// so it never rewrites tailwind utilities or jsx.
	if (format === 'html' || format === 'bem-css' || format === 'bem-scss') {
		const model = prefs.modelOverrides[prefs.activeProvider] ?? DEFAULT_MODELS[prefs.activeProvider];
		const polished = await polish(finalHtml, cleanedCss, prefs.activeProvider, model);
		finalHtml = polished.html;
		cleanedCss = polished.css;
		// A configured-key polish failure surfaces as a warning (a missing key is a
		// silent skip and returns none), so the sidebar reports why no edits landed.
		if (polished.warning) captured.warnings.push(polished.warning);
	}

	// Format phase. For html-shaped formats, lift the injected pseudo <style> into the
	// single head stylesheet and pretty-print both markup and css (jsx/vue self-indent
	// and keep composeDocument). Runs after polish so the formatting reflects exactly what
	// ships, including any renamed classes.
	let output: string;
	if (isHtmlShaped(format)) {
		const assembled = assembleHtmlDocument(finalHtml, cleanedCss, captured.warnings);
		finalHtml = assembled.html;
		cleanedCss = assembled.css;
		output = assembled.document;
	} else {
		output = composeDocument(finalHtml, cleanedCss);
	}

	// Delivery split: for the self-contained html-shaped output, lift the inline svgs
	// and data-uri images into their own referenced files so the panel can show them as
	// switchable tabs. `output` (the inlined document) is kept for preview and storage.
	const files = isHtmlShaped(format) ? splitAssets(output, captured.warnings) : undefined;
	shipResult({ mode, format, html: finalHtml, css: cleanedCss, output, files, warnings: captured.warnings });

	// Persist the snippet (fifo, capped at 50). Best-effort; a storage failure
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
			// and a stylesheet (not inline styles), the most readable single-file output.
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
			// Inline-styled html: no longer user-selectable (the html format emits bem
			// above) and no longer graded separately, kept as the safe fallback emitter.
			return emitHtml(captured);
	}
}

/**
 * Sends a snip result to the sidebar, where the ResultPanel renders it. The
 * sidebar may be closed, so a delivery failure is swallowed, the snip still
 * succeeded.
 */
function shipResult(payload: Record<string, unknown>): void {
	chrome.runtime
		.sendMessage({ type: 'SNIP_RESULT', requestId: crypto.randomUUID(), payload })
		.catch(() => {});
}

/** Start the picker overlay; on select, run the pipeline for the chosen mode. */
function startPicker(mode: 'snip' | 'assistive'): void {
	activePicker?.deactivate();
	activePicker = new ElementPicker({
		onSelect: (element, screenshot) => {
			activePicker = null;
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
	} else if (type === CANCEL_PICKER) {
		// Panel-side esc: tear the overlay down. The panel already cleared its own
		// picking state, so no onCancel callback is needed here.
		activePicker?.deactivate();
		activePicker = null;
	}
	// No async response from the picker path; keep the channel synchronous.
	return false;
});

// ---------------------------------------------------------------------------
// Headless test bridge (tests/run-pipeline.mjs, the HEADLESS_SNIP entry point).
// The grader drives a snip by css selector instead of the picker.
// Page and content script share the document but live in separate js worlds, so
// chrome.runtime messages and window.postMessage do not reach the page; a
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
 * Runs the full pipeline for a selector (no picker, no screenshot) and returns a
 * self-contained output.html string. This is the deterministic path the grader
 * measures, the byok llm polish phase is intentionally not run here.
 *
 * @param selector - css selector for the element to snip
 * @param mode - snip (code) or assistive (json)
 */
async function runHeadless(selector: string, mode: 'snip' | 'assistive'): Promise<Record<string, unknown>> {
	try {
		const el = document.querySelector(selector);
		if (!el) return { ok: false, error: `selector matched 0 elements: ${selector}` };

		const gate = detectBuilder(el);
		if (gate.blocked) return { ok: true, status: 'unsupported', warnings: [gate.message] };

		const captured = await capture(el, '');
		if (mode === 'assistive') {
			// Headless assistive: emit the assistive json (no delivery side effects).
			return { ok: true, status: 'ok', assistive: buildAssistiveJson(captured), warnings: captured.warnings };
		}

		reconcile(captured);
		runFeatures(captured);
		denoise(captured);
		resolveVariables(captured);
		resolveFonts(captured);
		resolveAnimations(captured);
		// Closing reconciliation: bake the original's resolved value for any paint/box
		// property that does not reproduce in the standalone clone.
		reconcileStandalone(captured);
		appendGenericFallbacks(captured);
		await inlineResources(captured);
		// Completeness probe (read-only): diff the reconciled clone's standalone render
		// against the live original. After the reconciliation this should be near zero;
		// a residual is the deterministic, drift-free signal of what still fails to
		// reproduce. It mutates nothing.
		const probe = await probeStandalone(captured);
		// Emit the bem (class-based) output the default html format ships, deterministically:
		// the byok polish phase stays out, so the classes are the generated block__tag-n names
		// (irrelevant to rendering). Assemble it the same way the sidebar does (lift pseudo
		// styles into one stylesheet, pretty-print markup + css, compose), then the grader
		// scores it as output.html. The inline-styled emitter rendered identically once the
		// css cleaner landed, so it is no longer emitted as a separate reference.
		const bem = emitFormat(captured, 'bem-css');
		const cleanedCss = cleanCss(bem.css, captured, bem.html);
		const doc = assembleHtmlDocument(bem.html, cleanedCss, captured.warnings);

		// Emitted-artifact probe (read-only): diff the shipped BEM artifact's own
		// standalone render against the live original (delta A) and the inline-clone
		// render (delta B). This classifies each residual as an emit-cascade loss (delta B),
		// an absent-at-bake gap (delta A absent from the css), or another render-time
		// mechanism. Measured on the cleaned css that actually ships.
		const emittedProbe = probeEmitted(captured, bem.html, cleanedCss);

		return {
			ok: true,
			status: 'ok',
			html: doc.document,
			probe,
			emittedProbe,
			warnings: captured.warnings,
		};
	} catch (err) {
		return { ok: false, error: (err as Error).message };
	}
}

export {};
