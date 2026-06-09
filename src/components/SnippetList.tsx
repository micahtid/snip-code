/**
 * components/SnippetList.tsx — saved-snippets view
 *
 * Phase: a (scaffold) — see SNIPCODE-REWRITE-PLAN.md section 12
 * Pipeline position: n/a (reads stored SnippetRecord[], section 19.10)
 * Reads from Captured: n/a
 * Writes to Captured: n/a
 *
 * Principles applied: none (ui).
 *
 * Why this exists: the extension keeps the last 50 snippets in
 * chrome.storage.local (fifo, decision 12) and offers one-click "export all" to
 * a zip. this view lists them and hosts the export button. empty stub at
 * scaffold stage; wired to storage in phase k (commit 38).
 */
export function SnippetList() {
	return (
		<div style={{ color: '#999', fontSize: '12px', lineHeight: 1.5 }}>
			no saved snippets yet.
		</div>
	);
}
