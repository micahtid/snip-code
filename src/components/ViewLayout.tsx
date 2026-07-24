/**
 * components/ViewLayout.tsx: the shared sidebar view scaffold
 *
 * Pipeline position: n/a. Ui only.
 * Reads from Captured: n/a
 * Writes to Captured: n/a
 *
 * Principles applied: none. Ui only.
 *
 * Why this exists: every sidebar view, capture / history / settings, plus their
 * loading and empty states, has the same shape: a scrolling body that fills the
 * panel over an optional footer pinned to the bottom. Centralizing that here keeps
 * the views structurally identical and is the one place the scroll/footer treatment
 * is applied. The values themselves live in LAYOUT in theme.ts. Pass `fill` when
 * the body's single child should grow to the full height, as with the capture view's
 * code block, rather than sit at its natural height.
 */
import { LAYOUT } from '../theme';

interface ViewLayoutProps {
	children: React.ReactNode;
	/** Pinned to the bottom, so it stays put while the body scrolls. Omit for no footer. */
	footer?: React.ReactNode;
	/** Let the body's single child grow to the full available height. */
	fill?: boolean;
}

export function ViewLayout({ children, footer, fill = false }: ViewLayoutProps) {
	return (
		<div style={LAYOUT.column}>
			<div className="sc-scroll" style={fill ? scrollFill : LAYOUT.scroll}>
				{children}
			</div>
			{footer && <div style={LAYOUT.footer}>{footer}</div>}
		</div>
	);
}

/**
 * The filling variant, used by the capture view. The top padding is small so the first row
 * below the nav, the shift banner or the code block, sits close under it; the banner adds its
 * own bottom margin to balance the gap the nav padding leaves above it. The bottom keeps the
 * full 14px: the footer's own 12px sits below its top border, not between the border and the card.
 */
const scrollFill: React.CSSProperties = { ...LAYOUT.scroll, display: 'flex', flexDirection: 'column', paddingTop: '4px' };
