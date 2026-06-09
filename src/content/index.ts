/**
 * content/index.ts — pipeline orchestrator + content-script entry point
 *
 * Phase: a (scaffold) — see SNIPCODE-REWRITE-PLAN.md section 12 for phase map
 * Pipeline position: spans 1-5 (this is the conductor, not a single phase)
 * Reads from Captured: n/a (constructs it)
 * Writes to Captured: n/a (owns the lifecycle)
 *
 * Principles applied: none directly; orchestrates the modules that apply P1-P5.
 *
 * Why this exists: chrome injects exactly one content script per page. this file
 * is that script. it owns the message protocol (section 19.2) and, once the
 * phases are built, runs them in order:
 *
 *   1 capture   → content/capture/*   (picker, dom clone, stylesheets, gate)
 *   2 reconcile → content/reconcile/* (P1+P2+P4, tier 1+2 feature handlers)
 *   3 resolve   → content/resolve/*   (P3 vars, fonts, keyframes — single pass)
 *   4 convert   → content/convert/*   (P5 dead-code elim, vault, format emit)
 *   5 polish    → content/polish/*    (byok llm rename + hover, vault restore)
 *
 * assistive mode runs only phase 1 then emits json via content/assistive/emit.
 *
 * at this stage the phases do not exist yet; this registers the message listener
 * and ships a minimal highlight overlay so the sidebar's "pick element" button
 * has something to drive. the full picker (highlighter, arrowup decoration
 * climb, screenshot integration — ported from v1 element-selector.ts) replaces
 * this minimal version in content/capture/picker.ts at commit 3.
 */

/** ui-local signal from the sidebar's picker control (components/Picker.tsx). */
const START_PICKER = 'SNIPCODE_START_PICKER';

/**
 * minimal element-highlight overlay.
 *
 * draws a single absolutely-positioned box that tracks whichever element the
 * pointer is over, so the user gets visual feedback while choosing. esc cancels;
 * arrowup walks to the parent element (the "decoration climb" from section 19.7,
 * implemented fully in capture/picker.ts later); click selects.
 *
 * this is intentionally throwaway scaffolding — commit 3 replaces it with the
 * real capture pipeline entry. it deliberately does not build a Captured object
 * yet (no types.ts until commit 3); selecting an element just logs the target.
 */
function startHighlightOverlay(): void {
	// avoid stacking overlays if the user clicks "pick element" twice.
	if (document.getElementById('snipcode-overlay')) return;

	const box = document.createElement('div');
	box.id = 'snipcode-overlay';
	Object.assign(box.style, {
		position: 'fixed',
		zIndex: '2147483647', // max — sit above any host-page stacking context.
		pointerEvents: 'none', // never intercept the hover/click we are tracking.
		border: '2px solid #4f6ef6',
		background: 'rgba(79, 110, 246, 0.12)',
		borderRadius: '2px',
		transition: 'all 40ms ease-out',
		top: '0',
		left: '0',
		width: '0',
		height: '0',
	} satisfies Partial<CSSStyleDeclaration>);
	document.body.appendChild(box);

	let current: Element | null = null;

	/** position the overlay box flush around `el`'s border rect. */
	const frame = (el: Element): void => {
		const r = el.getBoundingClientRect();
		Object.assign(box.style, {
			top: `${r.top}px`,
			left: `${r.left}px`,
			width: `${r.width}px`,
			height: `${r.height}px`,
		});
	};

	const onMove = (e: MouseEvent): void => {
		const el = e.target as Element | null;
		if (!el || el === box) return;
		current = el;
		frame(el);
	};

	/** tear down all listeners and remove the overlay. */
	const stop = (): void => {
		document.removeEventListener('mousemove', onMove, true);
		document.removeEventListener('keydown', onKey, true);
		document.removeEventListener('click', onClick, true);
		box.remove();
	};

	const onKey = (e: KeyboardEvent): void => {
		if (e.key === 'Escape') {
			e.preventDefault();
			stop();
			return;
		}
		// arrowup: climb to the parent so the user can grab a wrapping section
		// instead of the leaf they happen to be hovering (section 19.7).
		if (e.key === 'ArrowUp' && current?.parentElement) {
			e.preventDefault();
			current = current.parentElement;
			frame(current);
		}
	};

	const onClick = (e: MouseEvent): void => {
		e.preventDefault();
		e.stopPropagation();
		const selected = current;
		stop();
		// commit 3 turns this selection into a Captured object and runs the
		// pipeline. for now, confirm the wiring works end to end.
		if (selected) {
			console.info('snipcode: selected element', selected.tagName.toLowerCase(), selected);
		}
	};

	document.addEventListener('mousemove', onMove, true);
	document.addEventListener('keydown', onKey, true);
	document.addEventListener('click', onClick, true);
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, _sendResponse) => {
	// the sidebar's "pick element" button sends this to start the overlay.
	if (
		typeof message === 'object' &&
		message !== null &&
		'type' in message &&
		(message as { type: unknown }).type === START_PICKER
	) {
		startHighlightOverlay();
	}
	// no async response yet; keep the channel synchronous (return false).
	return false;
});

export {};
