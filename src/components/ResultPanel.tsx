/**
 * components/ResultPanel.tsx: snip output viewer, the code block
 *
 * Pipeline position: consumes convert/polish output, the emitted code
 * Reads from Captured: n/a. Renders the serialized SnipResult, not Captured.
 * Writes to Captured: n/a
 *
 * Principles applied: none. Ui only.
 *
 * Why this exists: after a snip completes the content script ships the generated
 * code to the side panel, where App listens (see App.tsx). This renders it as v1's
 * code block. A gradient header holds a copy action, a download action that saves
 * the files to disk, and, for the self-contained html-shaped formats, a preview
 * action that opens the rendered output in a new tab. Below the header sits a
 * monospace, scrollable code surface. Snip mode auto-persists the snippet in the
 * content script via storeSnippet, so the bookmark here is not a second write: it
 * toggles the `saved` flag on that stored record, which lifts the snippet into the
 * history view's Saved section and exempts it from the 50-cap eviction. Assistive
 * mode shows the emitted json, and a builder-gated page shows the static unsupported
 * message.
 *
 * Note: live format switching, re-emitting all 7 formats without a re-snip, is a
 * deliberate follow-up that is not wired here. `Captured` holds live dom and cannot be
 * shipped back to re-emit, and polish only applies to html/bem. The panel
 * renders whichever format the pipeline produced from the settings default output.
 */
import { useEffect, useState } from 'react';
import { Bookmark, Check, Copy, Download, Eye, MousePointer2 } from 'lucide-react';
import type { AssetFile, SnipPayload } from '../content/types';
import { EmptyState } from './EmptyState';
import { triggerDownload } from '../utils/download';
import { setSnippetSaved } from '../utils/storage';
import { COLORS, FLASH_MS, FONT_CODE, RADIUS, SURFACE } from '../theme';

/**
 * The snip output the content script ships to the panel as the shipResult payload. The
 * shape is declared once, next to the message constants that carry it, so sender and
 * renderer cannot drift; this alias is the name the panel side reads it under.
 */
export type SnipResult = SnipPayload;

interface ResultPanelProps {
	result: SnipResult | null;
}

export function ResultPanel({ result }: ResultPanelProps) {
	const [copied, setCopied] = useState(false);
	const [active, setActive] = useState(0);
	// Which snippet ids the user saved from this panel. A fresh snip lands unsaved, so the
	// bookmark starts as an outline and this set stays empty until the user clicks it.
	const [savedIds, setSavedIds] = useState<ReadonlySet<string>>(new Set());
	// A new snip resets the viewer to its first file, the index document, and clears the
	// save state so the bookmark reflects the new record rather than the previous one.
	useEffect(() => {
		setActive(0);
		setSavedIds(new Set());
	}, [result]);

	// Before the first snip the capture view shows a quiet pointer placeholder above
	// its pinned Pick Element action.
	if (!result) return <EmptyState Icon={MousePointer2} />;

	if (result.unsupported) {
		return (
			<div style={unsupported}>
				<div style={unsupportedTitle}>Unsupported Page</div>
				{result.message ?? `This page was built with ${result.builder ?? 'a site builder'}, so it cannot be snipped.`}
			</div>
		);
	}

	const code = result.mode === 'assistive' ? (result.json ?? '') : (result.output ?? result.html ?? '');

	// The output as switchable files. For html-shaped snips this is the pipeline's split,
	// index.html plus the lifted svg/image files. Otherwise it is one synthetic file for
	// json and other formats.
	const files: AssetFile[] = result.files?.length
		? result.files
		: [{ name: result.mode === 'assistive' ? 'output.json' : 'output.html', language: result.mode === 'assistive' ? 'json' : 'html', text: code }];
	const activeFile = files[Math.min(active, files.length - 1)]!; // files is never empty, per the fallback above
	const copyText = activeFile.text ?? activeFile.dataUrl ?? '';

	// Preview makes sense for the html-shaped formats, whose output is a self-contained
	// document (markup plus an inline stylesheet) that renders on its own. Those are the
	// html format with semantic bem classes plus css, and the bem-scss/legacy bem-css
	// variants. Tailwind/jsx/vue need a build step or a framework, so they would not render standalone.
	const PREVIEWABLE: ReadonlySet<string> = new Set(['html', 'bem-css', 'bem-scss']);
	// Preview renders the inlined self-contained document, so it works even though the
	// displayed index.html references the lifted files by name.
	const previewSource = result.output ?? result.html ?? '';
	const canPreview = result.mode === 'snip' && PREVIEWABLE.has(result.format ?? '') && previewSource.length > 0;

	// The stored record the bookmark toggles. Absent when the snip could not be persisted.
	const snippetId = result.snippetId;
	const isSaved = snippetId !== undefined && savedIds.has(snippetId);

	const onCopy = async (): Promise<void> => {
		try {
			await navigator.clipboard.writeText(copyText);
			setCopied(true);
			setTimeout(() => setCopied(false), FLASH_MS);
		} catch (err) {
			console.warn('snipcode: copy failed', err);
		}
	};

	const onPreview = (): void => {
		// Open the generated html in a new tab. A blob url is used because data: urls
		// are blocked for top-level navigation. The url is revoked once the new tab
		// has had time to load it.
		const url = URL.createObjectURL(new Blob([previewSource], { type: 'text/html' }));
		window.open(url, '_blank', 'noopener');
		setTimeout(() => URL.revokeObjectURL(url), 30000);
	};

	// Flip the saved flag on the stored record this snip was persisted under. The write is
	// best-effort, matching how the snip itself was persisted, so a storage failure only
	// warns and leaves the bookmark showing its real, unchanged state.
	const onToggleSaved = async (id: string): Promise<void> => {
		const next = !savedIds.has(id);
		try {
			await setSnippetSaved(id, next);
			setSavedIds((ids) => {
				const updated = new Set(ids);
				if (next) updated.add(id);
				else updated.delete(id);
				return updated;
			});
		} catch (err) {
			console.warn('snipcode: could not update saved state', err);
		}
	};

	// Save a single file to disk. Binary files (images, fonts) carry a data: url that
	// downloads directly. Text files such as html, svg, and json become a blob whose object
	// url is revoked once the browser has read it.
	const downloadFile = (file: AssetFile): void => {
		if (file.dataUrl) {
			triggerDownload(file.dataUrl, file.name);
			return;
		}
		const url = URL.createObjectURL(new Blob([file.text ?? ''], { type: mimeFor(file.language) }));
		triggerDownload(url, file.name);
		setTimeout(() => URL.revokeObjectURL(url), 30000);
	};

	// Download every file of a split snip, so index.html lands next to the svg/image
	// files it references and renders standalone, or the single file otherwise.
	const onDownload = (): void => {
		if (files.length > 1) files.forEach(downloadFile);
		else downloadFile(activeFile);
	};

	return (
		<div style={container}>
			<div style={header}>
				<div style={actions}>
					<button className="sc-icon-btn" title={copied ? 'Copied' : `Copy ${activeFile.name}`} onClick={() => void onCopy()}>
						{copied ? <Check size={16} /> : <Copy size={16} />}
					</button>
					<button
						className="sc-icon-btn"
						title={files.length > 1 ? 'Download all files' : `Download ${activeFile.name}`}
						onClick={onDownload}
					>
						<Download size={16} />
					</button>
					{canPreview && (
						<button className="sc-icon-btn" title="Preview in new tab" onClick={onPreview}>
							<Eye size={16} />
						</button>
					)}
					{result.mode === 'snip' && snippetId !== undefined && (
						<button
							className={`sc-icon-btn${isSaved ? ' sc-icon-btn-saved' : ''}`}
							title={isSaved ? 'Saved. Click to Unsave' : 'Save snippet'}
							aria-pressed={isSaved}
							aria-label={isSaved ? 'Unsave snippet' : 'Save snippet'}
							onClick={() => void onToggleSaved(snippetId)}
						>
							<Bookmark size={15} fill={isSaved ? 'currentColor' : 'none'} />
						</button>
					)}
				</div>
			</div>
			{files.length > 1 && (
				<div className="sc-scroll" style={tabBar} role="tablist">
					{files.map((file, i) => (
						<button
							key={file.name}
							role="tab"
							aria-selected={file === activeFile}
							className={`sc-tab${file === activeFile ? ' sc-tab-active' : ''}`}
							onClick={() => setActive(i)}
						>
							{file.name}
						</button>
					))}
				</div>
			)}
			{activeFile.language === 'image' ? (
				<div className="sc-scroll" style={imageWrap}>
					<img src={activeFile.dataUrl} alt={activeFile.name} style={imagePreview} />
				</div>
			) : activeFile.language === 'font' ? (
				<div style={binaryNote}>Binary font file. Use Download to save {activeFile.name}.</div>
			) : (
				<pre className="sc-scroll" style={display}>
					<code>{activeFile.text}</code>
				</pre>
			)}
			{result.warnings && result.warnings.length > 0 && (
				<div style={warn}>{result.warnings.length} Warning{result.warnings.length > 1 ? 's' : ''}</div>
			)}
		</div>
	);
}

/** The download mime type for a text file's language. Image files use their data: url instead. */
function mimeFor(language: AssetFile['language']): string {
	if (language === 'svg') return 'image/svg+xml';
	if (language === 'json') return 'application/json';
	return 'text/html';
}

const container: React.CSSProperties = {
	border: `1px solid ${SURFACE.border}`, borderRadius: `${RADIUS.xl}px`, background: COLORS.white,
	display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: SURFACE.shadow,
	// Fill the capture view's scroll region so the code body below grows to fit.
	flex: 1, minHeight: 0,
};
const header: React.CSSProperties = {
	display: 'flex', justifyContent: 'flex-end', alignItems: 'center', padding: '9px 12px',
	background: SURFACE.headerGradient, borderBottom: `1px solid ${SURFACE.border}`,
};
const actions: React.CSSProperties = { display: 'flex', gap: '2px', alignItems: 'center' };
const tabBar: React.CSSProperties = {
	display: 'flex', gap: '2px', padding: '0 8px', overflowX: 'auto',
	background: COLORS.white, borderBottom: `1px solid ${SURFACE.border}`,
};
const imageWrap: React.CSSProperties = {
	display: 'flex', alignItems: 'center', justifyContent: 'center',
	padding: '16px', flex: 1, minHeight: 0, overflow: 'auto', background: COLORS.slate50,
};
const imagePreview: React.CSSProperties = { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' };
const binaryNote: React.CSSProperties = {
	display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center',
	padding: '24px', flex: 1, minHeight: 0, background: COLORS.slate50, color: COLORS.slate500, fontSize: '12px',
};
const display: React.CSSProperties = {
	// Code never wraps: long lines scroll horizontally (overflow: auto) so the markup
	// reads as emitted rather than reflowing mid-attribute. tabSize narrows the
	// tab-indented output from the browser default of 8 columns so more fits per line.
	// flex: 1 lets the code body fill the remaining height of the result card.
	margin: 0, padding: '14px 16px', flex: 1, minHeight: 0, overflow: 'auto', background: COLORS.white,
	fontFamily: FONT_CODE, fontSize: '12px', lineHeight: 1.7, color: COLORS.slate800, whiteSpace: 'pre', tabSize: 2,
};
const warn: React.CSSProperties = { padding: '8px 12px', fontSize: '11px', color: COLORS.slate500, borderTop: `1px solid ${SURFACE.border}` };
const unsupported: React.CSSProperties = {
	fontSize: '13px', lineHeight: 1.6, color: COLORS.slate600,
};
const unsupportedTitle: React.CSSProperties = {
	fontWeight: 600, fontSize: '14px', marginBottom: '6px', color: COLORS.slate800,
};
