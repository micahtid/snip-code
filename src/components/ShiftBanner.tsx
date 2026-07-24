/**
 * components/ShiftBanner.tsx: the multi-select discovery hint
 *
 * Pipeline position: n/a. Ui only.
 * Reads from Captured: n/a
 * Writes to Captured: n/a
 *
 * Principles applied: none. Ui only.
 *
 * Why this exists: shift-click multi-select is undiscoverable, and the picker button's label
 * is the wrong place to teach it, since that label is a status line and the hint only matters
 * before the user starts selecting. This is a one-line strip at the top of the capture view
 * that says it once. It sits in the scroll body's block flow rather than overlaying anything,
 * so it pushes the code block down instead of covering it, and it scrolls away with the
 * content. It gets the first ten panel opens and then retires itself, or retires early if the
 * user closes it; that budget lives in utils/storage.ts and App owns claiming it.
 */
import { X } from 'lucide-react';
import { COLORS, RADIUS, SURFACE } from '../theme';

interface ShiftBannerProps {
	/** Retire the hint. App persists the flag and stops rendering this. */
	onDismiss: () => void;
}

export function ShiftBanner({ onDismiss }: ShiftBannerProps) {
	return (
		<div style={banner}>
			<span style={text}>Press Shift to select multiple elements.</span>
			<button className="sc-icon-btn" style={close} aria-label="Dismiss hint" title="Dismiss" onClick={onDismiss}>
				<X size={13} />
			</button>
		</div>
	);
}

const banner: React.CSSProperties = {
	display: 'flex', alignItems: 'center', gap: '7px', flexShrink: 0,
	padding: '8px 10px', marginBottom: '11px',
	// White over the frosted panel rather than a tint: the hint sits above the code card and a
	// colored strip competed with it for attention when the hint is the lesser of the two.
	background: COLORS.white, border: `1px solid ${SURFACE.border}`, borderRadius: `${RADIUS.sm}px`,
	boxShadow: SURFACE.shadow, fontSize: '11px', color: COLORS.slate600,
};
const text: React.CSSProperties = { flex: 1, minWidth: 0 };
const close: React.CSSProperties = { flexShrink: 0, padding: '2px', color: COLORS.slate500 };
