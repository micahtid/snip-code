/**
 * components/inspect/SchemaView.tsx: the schema inspector view
 *
 * Pipeline position: n/a, ui only
 * Reads from Captured: n/a
 * Writes to Captured: n/a
 *
 * Principles applied: none, ui only.
 *
 * Why this exists: renders the page's design-system schema as a scrollable code
 * block with copy and download. It uses its own small code surface rather than the
 * snip ResultPanel's. A schema is not a snip, so routing it through ResultPanel
 * would couple it to snip-only concerns: the format eyebrow, file tabs, and preview.
 * The surface still shares the theme tokens and the sc-icon-btn / sc-scroll classes
 * so it matches the snip code block visually.
 */
import { useState } from 'react';
import { Check, Copy, Download } from 'lucide-react';
import { triggerDownload } from '../../utils/download';
import { COLORS, FLASH_MS, FONT_CODE, RADIUS, SURFACE } from '../../theme';

export function SchemaView({ json }: { json: string }) {
	const [copied, setCopied] = useState(false);

	const onCopy = async (): Promise<void> => {
		try {
			await navigator.clipboard.writeText(json);
			setCopied(true);
			setTimeout(() => setCopied(false), FLASH_MS);
		} catch (err) {
			console.warn('snipcode: copy failed', err);
		}
	};

	const onDownload = (): void => {
		const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
		triggerDownload(url, 'schema.json');
		URL.revokeObjectURL(url);
	};

	return (
		<div style={container}>
			<div style={header}>
				<div style={actions}>
					<button className="sc-icon-btn" title={copied ? 'Copied' : 'Copy schema'} onClick={() => void onCopy()}>
						{copied ? <Check size={16} /> : <Copy size={16} />}
					</button>
					<button className="sc-icon-btn" title="Download schema.json" onClick={onDownload}>
						<Download size={16} />
					</button>
				</div>
			</div>
			<pre className="sc-scroll" style={display}>
				<code>{json}</code>
			</pre>
		</div>
	);
}

const container: React.CSSProperties = {
	border: `1px solid ${SURFACE.border}`, borderRadius: `${RADIUS.xl}px`, background: COLORS.white,
	display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: SURFACE.shadow, flex: 1, minHeight: 0,
};
const header: React.CSSProperties = {
	display: 'flex', justifyContent: 'flex-end', alignItems: 'center', padding: '9px 12px',
	background: SURFACE.headerGradient, borderBottom: `1px solid ${SURFACE.border}`,
};
const actions: React.CSSProperties = { display: 'flex', gap: '2px', alignItems: 'center' };
const display: React.CSSProperties = {
	margin: 0, padding: '14px 16px', flex: 1, minHeight: 0, overflow: 'auto', background: COLORS.white,
	fontFamily: FONT_CODE, fontSize: '12px', lineHeight: 1.7, color: COLORS.slate800, whiteSpace: 'pre', tabSize: 2,
};
