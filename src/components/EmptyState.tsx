/**
 * components/EmptyState.tsx: centered icon placeholder for an empty view
 *
 * Pipeline position: n/a. Ui only.
 * Reads from Captured: n/a
 * Writes to Captured: n/a
 *
 * Principles applied: none. Ui only.
 *
 * Why this exists: the capture and history views both show a quiet placeholder
 * before there is anything to display, whether because no snip has been taken yet or
 * there are no saved snippets. That placeholder is a single muted icon. Centralizing
 * it here keeps the two empty states identical and lets each view pass only the lucide
 * icon that fits its context. The icon fills the scroll region and sits just above its
 * vertical center, where paddingBottom biases it up.
 */
import type { LucideIcon } from 'lucide-react';
import { COLORS } from '../theme';

/** A single muted icon, centered slightly high in the scroll region. */
export function EmptyState({ Icon }: { Icon: LucideIcon }) {
	return (
		<div style={wrap}>
			<Icon size={40} strokeWidth={1.5} color={COLORS.slate400} />
		</div>
	);
}

const wrap: React.CSSProperties = {
	height: '100%',
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'center',
	paddingBottom: '64px',
};
