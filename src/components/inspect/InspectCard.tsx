/**
 * components/inspect/InspectCard.tsx: the shared inspector card
 *
 * Pipeline position: n/a, ui only
 * Reads from Captured: n/a
 * Writes to Captured: n/a
 *
 * Principles applied: none, ui only.
 *
 * Why this exists: the fonts, colors, and assets views are the same card shape, a
 * fixed preview slot beside a name and a meta line, with one click action that
 * copies or downloads and flashes a brief confirmation. Defining it once keeps the
 * spacing, hover, and the copied/downloaded feedback identical across all three
 * grids. Each grid supplies only the preview, the labels, and the action.
 */
import { useState, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { COLORS, FLASH_MS } from '../../theme';

interface InspectCardProps {
	/** The fixed-size preview: a font sample, a color swatch, or a thumbnail. */
	preview: ReactNode;
	name: string;
	/** The muted second line. Pass '' to show none, such as a color with no ai role. */
	meta: string;
	/** Runs on click, either a copy or a download. The card flashes `feedback` once it resolves. */
	onActivate: () => void | Promise<void>;
	/** The confirmation shown briefly after a successful action ("Copied" / "Downloaded"). */
	feedback: string;
	title: string;
}

export function InspectCard({ preview, name, meta, onActivate, feedback, title }: InspectCardProps) {
	const [flashed, setFlashed] = useState(false);

	const activate = async (): Promise<void> => {
		try {
			await onActivate();
		} catch (err) {
			console.warn('snipcode: inspect card action failed', err);
			return;
		}
		setFlashed(true);
		setTimeout(() => setFlashed(false), FLASH_MS);
	};

	return (
		<button className="sc-inspect-card" title={title} onClick={() => void activate()}>
			<span className="sc-inspect-preview">{preview}</span>
			<span className="sc-inspect-text">
				<span className="sc-inspect-name">{name}</span>
				{flashed ? (
					<span className="sc-inspect-meta" style={flashStyle}>
						<Check size={12} /> {feedback}
					</span>
				) : (
					meta && <span className="sc-inspect-meta">{meta}</span>
				)}
			</span>
		</button>
	);
}

const flashStyle: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: '3px', color: COLORS.accent };
