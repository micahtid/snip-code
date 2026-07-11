/**
 * components/ScissorsMark.tsx: the SnipCode brand mark, a pair of scissors
 *
 * Pipeline position: n/a. Ui component, not a pipeline phase.
 * Reads from Captured: n/a
 * Writes to Captured: n/a
 *
 * Why this exists: the sidebar nav and any future branding need the product's own
 * scissors mark rather than a stock icon. It draws the same geometry as the exported
 * app icon: two ring handles and two blades that cross over and under, with the lower
 * blade split into two segments so the upper blade reads as passing across it. It
 * renders in a single currentColor so it sits beside the lucide nav icons without
 * clashing. The two-tone treatment, the blue badge and the stepped blade tip, belongs
 * to the exported icon files, not to the ui.
 */

/** The brand scissors mark, sized and colored like a lucide nav icon. */
export function ScissorsMark({ size = 18 }: { size?: number | string }): React.ReactElement {
	return (
		<svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden="true">
			<g stroke="currentColor" strokeWidth={3.6} strokeLinecap="round" strokeLinejoin="round">
				<circle cx="12" cy="13" r="5.4" />
				<circle cx="12" cy="35" r="5.4" />
				<line x1="16.4" y1="16.4" x2="24" y2="24" />
				<line x1="39" y1="9" x2="16.4" y2="31.6" />
				<line x1="28.6" y1="28.8" x2="39" y2="39" />
			</g>
		</svg>
	);
}
