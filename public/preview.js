/**
 * preview.js: renders snipped output inside the sandboxed preview.html iframe.
 *
 * postMessage and injects it into #preview-root, isolated from the host page.
 * The real rendering logic lands alongside ResultPanel; scaffold wires the
 * message listener so the contract is stable from day one.
 */
window.addEventListener('message', (event) => {
	// Only act on our own typed messages; ignore noise from the host frame.
	const data = event.data;
	if (!data || data.type !== 'SNIPCODE_PREVIEW') return;

	const root = document.getElementById('preview-root');
	if (!root) return;

	if (data.css) {
		const style = document.createElement('style');
		style.textContent = data.css;
		document.head.appendChild(style);
	}
	root.innerHTML = data.html ?? '';
});
