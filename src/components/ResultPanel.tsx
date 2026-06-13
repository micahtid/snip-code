/**
 * components/ResultPanel.tsx: snip output viewer (the code block)
 *
 * Pipeline position: consumes convert/polish output (the emitted code)
 * Reads from Captured: n/a (renders the serialized SnipResult, not Captured)
 * Writes to Captured: n/a
 *
 * Principles applied: none (ui).
 *
 * Why this exists: after a snip completes the content script ships the generated
 * code to the side panel (App listens; see App.tsx). This renders it as v1's
 * code block, a gradient header with the format eyebrow and copy action over a
 * monospace, scrollable code surface. Snip mode auto-persists the snippet in the
 * content script (storeSnippet), so the bookmark here is a "saved"
 * indicator, not a second write. Assistive mode shows the emitted json; a
 * builder-gated page shows the static unsupported message.
 *
 * Note: live format switching (re-emitting all 7 formats without a re-snip) is a
 * deliberate follow-up, not wired here. `Captured` holds live dom and cannot be
 * shipped back to re-emit, and polish only applies to html/bem; the panel
 * renders whichever format the pipeline produced (settings -> default output).
 */
import { useState } from 'react';
import { Bookmark, Check, Copy } from 'lucide-react';
import type { OutputFormat } from '../content/types';
import { COLORS, FONT_CODE, RADIUS, SURFACE } from '../theme';

/** The snip output the content script ships to the panel (shipResult payload). */
export interface SnipResult {
	mode: 'snip' | 'assistive';
	format?: OutputFormat;
	html?: string;
	css?: string;
	/** Self-contained html document (snip mode); preferred for display + copy. */
	output?: string;
	/** Emitted assistive json (assistive mode). */
	json?: string;
	warnings?: string[];
	/** Set when the page is a blocked site builder (framer/wix/etc). */
	unsupported?: boolean;
	builder?: string;
	message?: string;
}

interface ResultPanelProps {
	result: SnipResult | null;
}

export function ResultPanel({ result }: ResultPanelProps) {
	const [copied, setCopied] = useState(false);

	if (!result) {
		return <div style={hint}>Pick an element to snip it. Output appears here.</div>;
	}

	if (result.unsupported) {
		return (
			<div style={unsupported}>
				<div style={{ fontWeight: 600, marginBottom: '4px', color: COLORS.slate700 }}>Unsupported page</div>
				{result.message ?? `This page is built with ${result.builder ?? 'a site builder'} and cannot be snipped.`}
			</div>
		);
	}

	const code = result.mode === 'assistive' ? (result.json ?? '') : (result.output ?? result.html ?? '');
	const eyebrow = result.mode === 'assistive' ? 'Assistive JSON' : (result.format ?? 'html').toUpperCase();

	const onCopy = async (): Promise<void> => {
		try {
			await navigator.clipboard.writeText(code);
			setCopied(true);
			setTimeout(() => setCopied(false), 1400);
		} catch (err) {
			console.warn('snipcode: copy failed', err);
		}
	};

	return (
		<div style={container}>
			<div style={header}>
				<span style={eyebrowStyle}>{eyebrow}</span>
				<div style={actions}>
					<button className="sc-icon-btn" title={copied ? 'Copied' : 'Copy'} onClick={() => void onCopy()}>
						{copied ? <Check size={16} /> : <Copy size={16} />}
					</button>
					{result.mode === 'snip' && (
						<span className="sc-icon-btn sc-icon-btn-saved" title="Saved to your snippets" aria-label="Saved">
							<Bookmark size={15} fill="currentColor" />
						</span>
					)}
				</div>
			</div>
			<pre className="sc-scroll" style={display}>
				<code>{code}</code>
			</pre>
			{result.warnings && result.warnings.length > 0 && (
				<div style={warn}>{result.warnings.length} warning{result.warnings.length > 1 ? 's' : ''} during capture</div>
			)}
		</div>
	);
}

const hint: React.CSSProperties = { color: COLORS.slate500, fontSize: '12px', lineHeight: 1.5 };
const container: React.CSSProperties = {
	border: `1px solid ${SURFACE.border}`, borderRadius: `${RADIUS.xl}px`, background: COLORS.white,
	display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: SURFACE.shadow,
};
const header: React.CSSProperties = {
	display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 12px',
	background: SURFACE.headerGradient, borderBottom: `1px solid ${SURFACE.border}`,
};
const eyebrowStyle: React.CSSProperties = { fontSize: '10px', fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase', color: COLORS.slate500 };
const actions: React.CSSProperties = { display: 'flex', gap: '2px', alignItems: 'center' };
const display: React.CSSProperties = {
	margin: 0, padding: '14px 16px', maxHeight: '380px', overflow: 'auto', background: COLORS.white,
	fontFamily: FONT_CODE, fontSize: '12px', lineHeight: 1.7, color: COLORS.slate800, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
};
const warn: React.CSSProperties = { padding: '8px 12px', fontSize: '11px', color: COLORS.slate500, borderTop: `1px solid ${SURFACE.border}` };
const unsupported: React.CSSProperties = {
	padding: '14px 16px', fontSize: '12px', lineHeight: 1.5, color: COLORS.slate600,
	border: `1px solid ${SURFACE.border}`, borderRadius: `${RADIUS.xl}px`, background: SURFACE.card,
};
