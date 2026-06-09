/**
 * background.js — mv3 service worker
 *
 * phase: a (scaffold). pipeline position: n/a (privileged broker, not a phase).
 *
 * this is the extension's only privileged context. it exists so the content
 * script (sandboxed, same-origin-limited) can reach things it cannot touch
 * directly: cross-origin stylesheet fetches, tab screenshots, and byok llm
 * provider calls. it routes the message protocol in section 19.2.
 *
 * at this scaffold stage it only wires the toolbar icon to open the side panel.
 * the fetch / screenshot / llm / storage handlers land in later phases
 * (b: stylesheet + screenshot, i: llm, k: snippet storage + export).
 *
 * security: this worker reads byok keys from chrome.storage.local to attach
 * auth headers, but never logs them and never persists them anywhere else.
 */

// open the side panel when the toolbar icon is clicked. requires the
// "sidePanel" permission and a side_panel entry in the manifest.
chrome.runtime.onInstalled.addListener(() => {
	if (chrome.sidePanel) {
		chrome.sidePanel
			.setPanelBehavior({ openPanelOnActionClick: true })
			.catch((err) => console.warn('snipcode: could not set side panel behavior', err));
	}
});

/**
 * message router (section 19.2). the content script reaches privileged apis
 * only through here. handlers reply via the Response envelope
 * { requestId, ok, result?, error? }. returning true keeps the channel open for
 * the async sendResponse.
 *
 * at commit 3 only CAPTURE_SCREENSHOT is wired (the picker needs it to crop a
 * thumbnail). FETCH_STYLESHEET lands in commit 4, the llm + storage handlers in
 * later phases.
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	if (!message || typeof message !== 'object') return false;

	switch (message.type) {
		case 'CAPTURE_SCREENSHOT': {
			// content scripts cannot call captureVisibleTab; the worker can. it
			// returns the whole viewport at device resolution and the content-side
			// picker crops to the element rect (it knows the dpr + scroll offsets).
			chrome.tabs
				.captureVisibleTab({ format: 'png' })
				.then((dataUrl) => sendResponse({ requestId: message.requestId, ok: true, result: { dataUrl } }))
				.catch((err) =>
					sendResponse({
						requestId: message.requestId,
						ok: false,
						error: { code: 'MALFORMED_REQUEST', message: String(err) },
					}),
				);
			return true; // async response
		}
		default:
			return false;
	}
});
