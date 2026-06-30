/**
 * components/inspect/SchemaView.tsx: the style-json inspector view
 *
 * Pipeline position: n/a (ui)
 * Reads from Captured: n/a
 * Writes to Captured: n/a
 *
 * Principles applied: none (ui).
 *
 * Why this exists: renders the page's design-system schema as a scrollable code
 * block with copy and download. It uses its own small code surface rather than the
 * snip ResultPanel's: a schema is not a snip, so routing it through ResultPanel
 * would couple it to snip-only concerns (the format eyebrow, file tabs, preview).
 * The surface still shares the theme tokens and the sc-icon-btn / sc-scroll classes
 * so it matches the snip code block visually.
 */
import { useState } from 'react';
import { Check, Copy, Download } from 'lucide-react';
import { COLORS, FONT_CODE, RADIUS, SURFACE } from '../../theme';

export function SchemaView({ json }: { json: string }) {
	const [copied, setCopied] = useState(false);

	const onCopy = async (): Promise<void> => {
		try {
			await navigator.clipboard.writeText(json);
			setCopied(true);
			setTimeout(() => setCopied(false), 1400);
		} catch (err) {
			console.warn('snipcode: copy failed', err);
		}
	};

	const onDownload = (): void => {
		const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
		const a = document.createElement('a');
		a.href = url;
		a.download = 'schema.json';
		a.click();
		URL.revokeObjectURL(url);
	};

	return (
		<div style={container}>
			<div style={header}>
				<span style={eyebrow}>Style JSON</span>
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
	display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 12px',
	background: SURFACE.headerGradient, borderBottom: `1px solid ${SURFACE.border}`,
};
const eyebrow: React.CSSProperties = { fontSize: '10px', fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase', color: COLORS.slate500 };
const actions: React.CSSProperties = { display: 'flex', gap: '2px', alignItems: 'center' };
const display: React.CSSProperties = {
	margin: 0, padding: '14px 16px', flex: 1, minHeight: 0, overflow: 'auto', background: COLORS.white,
	fontFamily: FONT_CODE, fontSize: '12px', lineHeight: 1.7, color: COLORS.slate800, whiteSpace: 'pre', tabSize: 2,
};
