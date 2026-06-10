/**
 * components/ResultPanel.tsx: snip output viewer
 *
 * Phase: a (scaffold), see SNIPCODE-REWRITE-PLAN.md section 12
 * Pipeline position: consumes pipeline phase 4/5 output (the emitted code)
 * Reads from Captured: n/a (reads the serialized output, not Captured itself)
 * Writes to Captured: n/a
 *
 * Principles applied: none (ui).
 *
 * Why this exists: after a snip completes, the user needs to see and copy the
 * generated code and switch between the 7 output formats, plus the colors,
 * fonts, and assets panels (section 9, snip mode). this is an empty stub at
 * scaffold stage; the format switcher and copy actions land in phase e (convert)
 * when there is real output to show.
 */
export function ResultPanel() {
	return (
		<div style={{ color: '#999', fontSize: '12px', lineHeight: 1.5 }}>
			pick an element to snip it. output appears here.
		</div>
	);
}
