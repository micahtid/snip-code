/**
 * components/SettingsView.tsx — byok + preferences settings tab
 *
 * Phase: a (scaffold) — see SNIPCODE-REWRITE-PLAN.md section 12
 * Pipeline position: n/a (configures pipeline phase 5 + delivery)
 * Reads from Captured: n/a
 * Writes to Captured: n/a
 *
 * Principles applied: none (ui).
 *
 * Why this exists: section 10 specifies the settings tab — provider dropdown,
 * password-masked api key, model override, test-key button, default output
 * format, assistive delivery, webhook url. all of it stores to
 * chrome.storage.local only (never sync). empty stub at scaffold stage; the full
 * byok form lands in phase i (commit 35).
 */
export function SettingsView() {
	return (
		<div style={{ color: '#999', fontSize: '12px', lineHeight: 1.5 }}>
			settings (byok, output format, delivery) land here.
		</div>
	);
}
