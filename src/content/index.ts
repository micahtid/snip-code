/**
 * content/index.ts — pipeline orchestrator + content-script entry point
 *
 * Phase: b (capture) — see SNIPCODE-REWRITE-PLAN.md section 12 for phase map
 * Pipeline position: spans 1-5 (this is the conductor, not a single phase)
 * Reads from Captured: constructs it (capture phase), reads it downstream
 * Writes to Captured: owns the lifecycle
 *
 * Principles applied: none directly; orchestrates the modules that apply P1-P5.
 *
 * Why this exists: chrome injects exactly one content script per page. this file
 * is that script. it owns the message protocol (section 19.2) and runs the
 * phases in order. as of commit 3 only pipeline phase 1 (capture) is wired:
 *
 *   1 capture   → content/capture/*   (picker → dom clone → stylesheet discovery)
 *   2 reconcile → content/reconcile/* (commits 6-7, g, h)
 *   3 resolve   → content/resolve/*   (commit 8)
 *   4 convert   → content/convert/*   (commits 9-15)
 *   5 polish    → content/polish/*    (commits 35-36)
 *
 * capture produces a Captured object; at this stage the pipeline emits the raw
 * cloned html (no styling baked yet) so the wiring is observable end to end. the
 * reconcile→convert phases that turn it into clean code arrive in later commits.
 */
import type { Captured } from './types';
import { ElementPicker } from './capture/picker';
import { buildElementMetadata, cloneElement, serializeRaw } from './capture/dom';
import { discoverStylesheets } from './capture/sheets';
import { augmentInheritedChainViaCDP, recoverCrossOriginSheets } from './capture/cdp';
import { detectBuilder } from './capture/gate';

/** ui-local signal from the sidebar's picker control (components/Picker.tsx). */
const START_PICKER = 'SNIPCODE_START_PICKER';

/** only one picker may be active at a time. */
let activePicker: ElementPicker | null = null;

/**
 * runs pipeline phase 1 (capture) on the chosen element, assembling the shared
 * Captured object every later phase reads.
 *
 * @param root — the live element the user picked
 * @param screenshot — cropped png data url from the picker (may be empty)
 * @returns the populated Captured object
 */
async function capture(root: Element, screenshot: string): Promise<Captured> {
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
			closedShadowRoots: 0, // cdp shadow-pierce lands in commit 4.
		},
		bakedStyles: new Map(),
		warnings: [],
	};

	// privileged augmentation (background-mediated). both soft-fail: the snip
	// proceeds on cssom-only data if cdp attach is refused or a fetch is blocked.
	await augmentInheritedChainViaCDP(captured); // P2 inherited cascade via cdp
	await recoverCrossOriginSheets(captured); // recover cors-blocked sheets

	return captured;
}

/**
 * runs the pipeline for a selected element and ships a result to the sidebar.
 *
 * at commit 3 the pipeline stops after capture and emits raw cloned html. later
 * commits insert reconcile→resolve→convert→polish between capture and emit.
 *
 * @param root — the picked element
 * @param screenshot — cropped png data url
 * @param mode — snip (code) or assistive (json); assistive emit is fully built
 *   in commit 37, so here it ships the metadata block as a json preview
 */
async function runPipeline(root: Element, screenshot: string, mode: 'snip' | 'assistive'): Promise<void> {
	// builder gate (decision 5): refuse framer/wix/etc before doing any capture
	// work. cheap structural check; on a hit we emit a static unsupported message
	// and stop — no degraded fallback output.
	const gate = detectBuilder(root);
	if (gate.blocked) {
		chrome.runtime
			.sendMessage({
				type: 'SNIP_RESULT',
				requestId: crypto.randomUUID(),
				payload: { mode, unsupported: true, builder: gate.builder, message: gate.message },
			})
			.catch(() => {});
		console.info('snipcode: snip refused (builder gate)', gate.builder);
		return;
	}

	const captured = await capture(root, screenshot);
	const result =
		mode === 'assistive'
			? { mode, json: JSON.stringify({ page: captured.page, element: captured.element }, null, 2) }
			: { mode, html: serializeRaw(captured.clone) };

	// hand the result to the sidebar. the ResultPanel renders it from phase e on;
	// until then this message is the observable output of a snip.
	chrome.runtime
		.sendMessage({ type: 'SNIP_RESULT', requestId: crypto.randomUUID(), payload: result })
		.catch(() => {
			// sidebar may be closed; the snip still succeeded. swallow.
		});
	console.info('snipcode: snip complete', result);
}

/** start the picker overlay; on select, run the pipeline for the chosen mode. */
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
	if (
		typeof message === 'object' &&
		message !== null &&
		'type' in message &&
		(message as { type: unknown }).type === START_PICKER
	) {
		const mode = (message as { mode?: unknown }).mode === 'assistive' ? 'assistive' : 'snip';
		startPicker(mode);
	}
	// no async response from the picker path; keep the channel synchronous.
	return false;
});

export {};
