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
 * at scaffold stage the phases do not exist yet; this only registers the
 * message listener so the HEADLESS_SNIP entry point (used by the grader at
 * commit 17) and the picker trigger have a stable home to grow into.
 */

// the full message-protocol envelope/response types land in content/types.ts at
// commit 3 (capture). until then the listener is a typed-loose placeholder so
// the bundle builds and the wiring is reviewable.
chrome.runtime.onMessage.addListener((_message, _sender, _sendResponse) => {
	// phases are not wired yet (scaffold). returning false keeps the channel
	// synchronous so chrome does not hold it open waiting for a response.
	return false;
});

export {};
