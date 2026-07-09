/**
 * components/inspect/InspectPanel.tsx: routes a page-scan result to its view
 *
 * Pipeline position: n/a, ui only
 * Reads from Captured: n/a
 * Writes to Captured: n/a
 *
 * Principles applied: none, ui only.
 *
 * Why this exists: a page scan ships one discriminated InspectResult, and App listens
 * (see App.tsx). This is the panel-side terminus. It selects the matching view by
 * `kind`, a card grid for fonts/colors/assets or a code block for the schema, and
 * shows a shared warnings line beneath it, so each view only renders its own cards.
 */
import type { InspectResult } from '../../content/inspect/types';
import { COLORS } from '../../theme';
import { FontGrid } from './FontGrid';
import { AssetGrid } from './AssetGrid';
import { ColorGrid } from './ColorGrid';
import { SchemaView } from './SchemaView';

export function InspectPanel({ result }: { result: InspectResult }) {
	return (
		<div style={panel}>
			{renderView(result)}
			{result.warnings.length > 0 && (
				<div style={warn}>
					{result.warnings.length} warning{result.warnings.length > 1 ? 's' : ''} during scan
				</div>
			)}
		</div>
	);
}

/** Pick the view for this result's kind. */
function renderView(result: InspectResult): React.ReactNode {
	switch (result.kind) {
		case 'fonts':
			return <FontGrid fonts={result.fonts} />;
		case 'assets':
			return <AssetGrid assets={result.assets} />;
		case 'colors':
			return <ColorGrid colors={result.colors} />;
		case 'schema':
			return <SchemaView json={result.json} />;
	}
}

const panel: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: '10px', flex: 1, minHeight: 0 };
const warn: React.CSSProperties = { fontSize: '11px', color: COLORS.slate500 };
