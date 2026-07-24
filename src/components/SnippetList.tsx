/**
 * components/SnippetList.tsx: the history view that lists stored snippets
 *
 * Pipeline position: n/a. Reads stored SnippetRecord[].
 * Reads from Captured: n/a
 * Writes to Captured: n/a
 *
 * Principles applied: none. Ui only.
 *
 * Why this exists: snipcode keeps the last 50 unsaved snippets in chrome.storage.local
 * in fifo order, plus every snippet the user saved, which is exempt from that cap. This
 * view renders both from the one stored list, split into a Saved section above a History
 * section, each with a live count. Every card carries a bookmark toggle, so a snippet can
 * be saved or unsaved from here as well as from the result panel, and unsaving drops it
 * back into History where it ages out normally. Clicking a card downloads that one
 * snippet's component, its code file plus a stylesheet when the format keeps css apart.
 * "Export all" zips every snippet, saved and unsaved, into a folder each, built in the
 * sidebar with jszip. "Clear History" drops the unsaved snippets only.
 */
import { useEffect, useState } from 'react';
import { Bookmark, LibraryBig } from 'lucide-react';
import type { OutputFormat, SnippetRecord } from '../content/types';
import { EmptyState } from './EmptyState';
import { ViewLayout } from './ViewLayout';
import { clearSnippets, listSnippets, setSnippetSaved } from '../utils/storage';
import { dataUrlToBase64, downloadBlob, downloadZip, type ZipEntry } from '../utils/download';
import { COLORS, FONT_UI, RADIUS, SURFACE } from '../theme';

const EXT: Record<OutputFormat, string> = {
	html: 'html', tailwind: 'html', 'bem-css': 'html', 'bem-scss': 'html',
	'jsx-tailwind': 'jsx', 'jsx-css': 'jsx', vue: 'vue',
};

export function SnippetList() {
	const [snippets, setSnippets] = useState<SnippetRecord[] | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		void refresh().then(setSnippets);
	}, []);

	if (!snippets) return <ViewLayout><div style={muted}>Loading…</div></ViewLayout>;
	if (snippets.length === 0) {
		return <ViewLayout><EmptyState Icon={LibraryBig} /></ViewLayout>;
	}

	// Both sections read from the same stored list, so a save is one flag flip rather than a
	// move between two stores. Newest-first ordering is already applied by refresh.
	const saved = snippets.filter((snip) => snip.saved);
	const history = snippets.filter((snip) => !snip.saved);

	const onExport = async (): Promise<void> => {
		setBusy(true);
		try {
			await exportZip(snippets);
		} finally {
			setBusy(false);
		}
	};

	// Clear is scoped to history, so the saved snippets stay. Re-read rather than assume,
	// since storage owns which records survive.
	const onClear = async (): Promise<void> => {
		await clearSnippets();
		setSnippets(await refresh());
	};

	// Toggling save can evict the record it just unsaved, once history is at the cap, so the
	// list is re-read from storage instead of patched locally.
	const onToggleSaved = async (snip: SnippetRecord): Promise<void> => {
		try {
			await setSnippetSaved(snip.id, !snip.saved);
			setSnippets(await refresh());
		} catch (err) {
			console.warn('snipcode: could not update saved state', err);
		}
	};

	const footer = (
		<div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
			<button className="sc-btn sc-btn-primary" style={{ fontFamily: FONT_UI }} disabled={busy} onClick={() => void onExport()}>
				{busy ? 'Zipping…' : `Export All (${snippets.length})`}
			</button>
			<button className="sc-btn sc-btn-secondary" style={{ width: '100%', fontFamily: FONT_UI }} onClick={() => void onClear()}>
				Clear History
			</button>
		</div>
	);

	const card = (snip: SnippetRecord): React.ReactNode => (
		<div key={snip.id} className="sc-history-card">
			<button
				className="sc-history-hit"
				title={`Download ${snip.page.title || 'snippet'}`}
				onClick={() => downloadSnippet(snip)}
			>
				{snip.screenshot ? (
					<img src={snip.screenshot} alt="" style={thumb} />
				) : (
					<div style={{ ...thumb, background: COLORS.slate100 }} />
				)}
				<div style={{ overflow: 'hidden' }}>
					<div style={{ fontWeight: 600, color: COLORS.slate800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
						{snip.page.title || snip.page.url}
					</div>
					<div style={{ color: COLORS.slate500, fontSize: '11px' }}>
						{snip.output.format.toUpperCase()} · {new Date(snip.capturedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
					</div>
				</div>
			</button>
			<button
				className={`sc-icon-btn${snip.saved ? ' sc-icon-btn-saved' : ''}`}
				title={snip.saved ? 'Saved. Click to Unsave' : 'Save snippet'}
				aria-pressed={snip.saved === true}
				aria-label={snip.saved ? 'Unsave snippet' : 'Save snippet'}
				onClick={() => void onToggleSaved(snip)}
			>
				<Bookmark size={15} fill={snip.saved ? 'currentColor' : 'none'} />
			</button>
		</div>
	);

	return (
		<ViewLayout footer={footer}>
			{/* An empty Saved section renders nothing at all; the empty state above already
			    covers the case where both sections are empty. */}
			{saved.length > 0 && (
				<>
					<div className="sc-section-title">Saved ({saved.length})</div>
					{saved.map(card)}
				</>
			)}
			{history.length > 0 && (
				<>
					<div className="sc-section-title">History ({history.length})</div>
					{history.map(card)}
				</>
			)}
		</ViewLayout>
	);
}

/** Read the stored snippets newest first, the order both sections render in. */
async function refresh(): Promise<SnippetRecord[]> {
	const stored = await listSnippets();
	return stored.slice().reverse();
}

/**
 * Download one snippet's component: its code file, plus a separate stylesheet when the
 * format keeps css apart. Mirrors the per-snippet files exportZip writes into each folder.
 */
function downloadSnippet(snip: SnippetRecord): void {
	const base = slug(snip.page.title || 'snippet');
	downloadText(`${base}.${EXT[snip.output.format]}`, snip.output.html);
	if (snip.output.css) downloadText(`${base}.css`, snip.output.css);
}

/** Save a text file to disk as a utf-8 blob. */
function downloadText(name: string, text: string): void {
	downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), name);
}

/** Build a zip with one folder per snippet, holding code, screenshot, and meta, and download it. */
async function exportZip(snippets: SnippetRecord[]): Promise<void> {
	await downloadZip('snipcode-snippets.zip', snippets.flatMap((snip, i) => exportEntries(snip, i)));
}

/** The zip files for one exported snippet, all under that snippet's own folder. */
function exportEntries(snip: SnippetRecord, index: number): ZipEntry[] {
	const folder = `${String(index + 1).padStart(2, '0')}-${slug(snip.page.title || 'snippet')}`;
	const meta = { page: snip.page, element: snip.element, format: snip.output.format, capturedAt: snip.capturedAt };
	const entries: ZipEntry[] = [
		{ path: `${folder}/code.${EXT[snip.output.format]}`, text: snip.output.html },
		{ path: `${folder}/meta.json`, text: JSON.stringify(meta, null, 2) },
	];
	if (snip.output.css) entries.push({ path: `${folder}/styles.css`, text: snip.output.css });
	const png = dataUrlToBase64(snip.screenshot);
	if (png) entries.push({ path: `${folder}/screenshot.png`, base64: png });
	return entries;
}

/** Filesystem-safe slug for a folder or file name. */
function slug(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'snippet';
}

const muted: React.CSSProperties = { color: COLORS.slate500, fontSize: '12px' };
const thumb: React.CSSProperties = { width: '40px', height: '40px', objectFit: 'cover', borderRadius: `${RADIUS.md}px`, flexShrink: 0, border: `1px solid ${SURFACE.border}` };
