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
 * A multi-select snip arrives as one result carrying a `components` array. The tabs are two
 * tiers: a row of `component-1`, `component-2` tabs on top, and that component's files below
 * as a second row of file-name tabs, both styled alike. Copy, preview, and the save bookmark
 * all act on whichever component is active. Download-all becomes a single zip with a folder
 * per component, since firing one prompt per file across n components is unusable.
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
import { dataUrlToBase64, downloadZip, triggerDownload, type ZipEntry } from '../utils/download';
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
	// Which component is being viewed, and which of its files. Two pieces of state rather than
	// one flat index, because the tabs are two tiers: components on top, that component's files
	// below. Switching component always lands on its first file, the index document.
	const [activeComponent, setActiveComponent] = useState(0);
	const [activeFileIndex, setActiveFileIndex] = useState(0);
	// Which snippet ids the user saved from this panel. A fresh snip lands unsaved, so the
	// bookmark starts as an outline and this set stays empty until the user clicks it.
	const [savedIds, setSavedIds] = useState<ReadonlySet<string>>(new Set());
	// A new snip opens on component 1's first file, the index document, and clears the save
	// state so the bookmark reflects the new record rather than the previous one.
	useEffect(() => {
		setActiveComponent(0);
		setActiveFileIndex(0);
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

	// The result grouped by component, each carrying its own files. A single snip is one
	// component; a batch is one per selected element, numbered as the overlay numbered them.
	const components = buildViews(result);
	const component = components[Math.min(activeComponent, components.length - 1)];
	const warnings = collectWarnings(result, component);

	// A batch whose every element failed has nothing to render. Show the same quiet empty
	// state a pre-snip panel shows, with the per-element reasons beneath it.
	if (!component) {
		return (
			<>
				<EmptyState Icon={MousePointer2} />
				{warnings.length > 0 && <div style={warn}>{warningLabel(warnings.length)}</div>}
			</>
		);
	}

	const activeFile = component.files[Math.min(activeFileIndex, component.files.length - 1)]!;
	// The result the active tab belongs to: the whole result for a single snip, or the one
	// component for a batch. Preview and save both act on this, not on the batch envelope.
	const source = component.source;
	const copyText = activeFile.text ?? activeFile.dataUrl ?? '';

	// Preview makes sense for the html-shaped formats, whose output is a self-contained
	// document (markup plus an inline stylesheet) that renders on its own. Those are the
	// html format with semantic bem classes plus css, and the bem-scss/legacy bem-css
	// variants. Tailwind/jsx/vue need a build step or a framework, so they would not render standalone.
	const PREVIEWABLE: ReadonlySet<string> = new Set(['html', 'bem-css', 'bem-scss']);
	// Preview renders the inlined self-contained document, so it works even though the
	// displayed index.html references the lifted files by name.
	const previewSource = source.output ?? source.html ?? '';
	const canPreview = source.mode === 'snip' && PREVIEWABLE.has(source.format ?? '') && previewSource.length > 0;

	// The stored record the bookmark toggles: the active component's for a batch, since each
	// component was persisted as its own snippet. Absent when the snip could not be persisted.
	const snippetId = source.snippetId;
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

	// Download every file of a split snip, so index.html lands next to the svg/image files it
	// references and renders standalone, or the single file otherwise. A batch instead saves
	// one zip with a folder per component, since n components times m files would otherwise
	// fire a download prompt each. File names inside a folder are the original ones, so each
	// component's index.html still finds the assets it references.
	const onDownload = (): void => {
		if (components.length > 1) {
			const entries = components.flatMap((view) => view.files.map((file) => zipEntry(view, file)));
			void downloadZip('snipcode-components.zip', entries).catch((err) => {
				console.warn('snipcode: could not build the component zip', err);
			});
			return;
		}
		component.files.forEach(downloadFile);
	};

	return (
		<div style={container}>
			<div style={header}>
				{/* Copy and save are the one-tap actions and sit together on the left; view and
				    download are heavier and less frequent, so they sit on the right. */}
				<div style={actions}>
					<button className="sc-icon-btn" title={copied ? 'Copied' : `Copy ${activeFile.name}`} onClick={() => void onCopy()}>
						{copied ? <Check size={16} /> : <Copy size={16} />}
					</button>
					{source.mode === 'snip' && snippetId !== undefined && (
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
					{canPreview && (
						<button className="sc-icon-btn" title="Preview in new tab" onClick={onPreview}>
							<Eye size={16} />
						</button>
					)}
					<button
						className="sc-icon-btn"
						style={downloadAction}
						title={
							components.length > 1
								? 'Download all components as a zip'
								: component.files.length > 1
									? 'Download all files'
									: `Download ${activeFile.name}`
						}
						onClick={onDownload}
					>
						<Download size={16} />
					</button>
				</div>
			</div>
			{components.length > 1 && (
				<div className="sc-scroll" style={componentBar} role="tablist" aria-label="Components">
					{components.map((view, i) => (
						<button
							key={view.index}
							role="tab"
							aria-selected={view === component}
							className={`sc-tab${view === component ? ' sc-tab-active' : ''}`}
							onClick={() => {
								setActiveComponent(i);
								setActiveFileIndex(0);
							}}
						>
							component-{view.index}
						</button>
					))}
				</div>
			)}
			{component.files.length > 1 && (
				<div className="sc-scroll" style={fileBar} role="tablist" aria-label="Files">
					{component.files.map((file, i) => (
						<button
							key={file.name}
							role="tab"
							aria-selected={file === activeFile}
							className={`sc-tab${file === activeFile ? ' sc-tab-active' : ''}`}
							onClick={() => setActiveFileIndex(i)}
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
			{warnings.length > 0 && <div style={warn}>{warningLabel(warnings.length)}</div>}
		</div>
	);
}

/** One component of a snip: its number, the result it came from, and its own files. */
interface ComponentView {
	/** 1 based, matching the number the overlay drew on that element while it was pinned. */
	index: number;
	/** The result this component's files belong to: the whole result, or one of a batch. */
	source: SnipResult;
	files: AssetFile[];
}

/**
 * Group a result by component. A batch becomes one entry per selected element, numbered as
 * the overlay numbered it, and a single snip is exactly one entry. A component that produced
 * no files, an element the pipeline could not emit, is dropped, so the numbering follows the
 * components that actually rendered. File names are never rewritten, because each component's
 * index.html references its stylesheet and assets by name: the `component-2/` prefix lives
 * only in the zip layout, which keeps those relative references intact.
 *
 * @param result - the shipped snip result
 * @returns one view per component, in pin order
 */
function buildViews(result: SnipResult): ComponentView[] {
	if (result.components) {
		return result.components
			.map((component, i) => ({ index: i + 1, source: component, files: filesOf(component) }))
			.filter((view) => view.files.length > 0);
	}
	const files = filesOf(result);
	return files.length > 0 ? [{ index: 1, source: result, files }] : [];
}

/**
 * The single file a format that skips the asset split delivers, keyed by output format. Only
 * the html-shaped formats go through splitAssets and get a file set of their own; everything
 * else is one file, and this is what it is called. Adding a format is one line here.
 */
const FALLBACK_FILE: Record<string, { name: string; language: AssetFile['language'] }> = {
	tailwind: { name: 'index.html', language: 'html' },
	'jsx-tailwind': { name: 'Component.jsx', language: 'jsx' },
	'jsx-css': { name: 'Component.jsx', language: 'jsx' },
	vue: { name: 'Component.vue', language: 'vue' },
};

/**
 * One result's files. For html-shaped snips this is the pipeline's split, index.html plus
 * styles.css plus the lifted svg/image files. Otherwise it is one file named for the format,
 * so a jsx snip downloads as Component.jsx rather than as a synthetic output.html.
 */
function filesOf(result: SnipResult): AssetFile[] {
	if (result.files?.length) return result.files;
	const code = result.mode === 'assistive' ? (result.json ?? '') : (result.output ?? result.html ?? '');
	if (!code) return [];
	if (result.mode === 'assistive') return [{ name: 'output.json', language: 'json', text: code }];
	const fallback = FALLBACK_FILE[result.format ?? ''] ?? { name: 'index.html', language: 'html' as const };
	return [{ name: fallback.name, language: fallback.language, text: code }];
}

/**
 * The warnings the panel counts: a single snip's own, or, for a batch, the batch-level ones
 * such as a skipped element plus those of the component being viewed.
 */
function collectWarnings(result: SnipResult, view: ComponentView | undefined): string[] {
	const own = result.warnings ?? [];
	if (!result.components || !view) return own;
	return [...own, ...(view.source.warnings ?? [])];
}

/** "3 Warnings", singular at one. */
function warningLabel(count: number): string {
	return `${count} Warning${count > 1 ? 's' : ''}`;
}

/** One zip entry for a file, filed under its component folder with its original file name. */
function zipEntry(view: ComponentView, file: AssetFile): ZipEntry {
	const path = `component-${view.index}/${file.name}`;
	return file.dataUrl ? { path, base64: dataUrlToBase64(file.dataUrl) } : { path, text: file.text ?? '' };
}

/** The download mime type for a text file's language. Image files use their data: url instead. */
function mimeFor(language: AssetFile['language']): string {
	if (language === 'css') return 'text/css';
	if (language === 'svg') return 'image/svg+xml';
	if (language === 'json') return 'application/json';
	if (language === 'jsx' || language === 'vue') return 'text/plain';
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
/** Separates the heavy download action from the light copy/save pair beside it. */
const downloadAction: React.CSSProperties = { marginLeft: '4px' };
/** The component tabs, one per selected element, as file-style tabs rather than round pills. */
const componentBar: React.CSSProperties = {
	display: 'flex', gap: '2px', alignItems: 'center', padding: '0 8px', overflowX: 'auto',
	background: COLORS.white, borderBottom: `1px solid ${SURFACE.border}`,
};
/** Every file of the active component, styled alike: a stylesheet is not more of a file than an icon. */
const fileBar: React.CSSProperties = {
	display: 'flex', gap: '2px', alignItems: 'center', padding: '0 8px', overflowX: 'auto',
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
