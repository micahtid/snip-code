/**
 * components/inspect/ColorGrid.tsx: the colors inspector view
 *
 * Pipeline position: n/a, ui only
 * Reads from Captured: n/a
 * Writes to Captured: n/a
 *
 * Principles applied: none, ui only.
 *
 * Why this exists: renders the page's colors as a grid of cards, each a swatch beside
 * its hex value and, when the byok ai pass ran, its semantic role, such as primary
 * or accent. Clicking a card copies the hex.
 */
import type { ColorReport } from '../../content/inspect/types';
import { InspectCard } from './InspectCard';

export function ColorGrid({ colors }: { colors: ColorReport[] }) {
	return (
		<div className="sc-inspect-grid">
			{colors.map((color, i) => (
				<InspectCard
					key={`${color.hex}-${i}`}
					preview={<span className="sc-color-swatch" style={{ background: color.hex }} />}
					name={color.hex}
					meta={color.role ? titleCase(color.role) : ''}
					onActivate={() => navigator.clipboard.writeText(color.hex)}
					feedback="Copied"
					title={`Copy ${color.hex}`}
				/>
			))}
		</div>
	);
}

/** Capitalize a role for display ("primary" -> "Primary"). */
function titleCase(role: string): string {
	return role.charAt(0).toUpperCase() + role.slice(1);
}
