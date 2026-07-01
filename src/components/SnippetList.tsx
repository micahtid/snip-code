/**
 * components/SnippetList.tsx: the history view that lists saved snippets
 *
 * Pipeline position: n/a. Reads stored SnippetRecord[].
 * Reads from Captured: n/a
 * Writes to Captured: n/a
 *
 * Principles applied: none. Ui only.
 *
 * Why this exists: snipcode keeps the last 50 snippets in chrome.storage.local
 * in fifo order and offers one-click "export all" to a zip with one folder
 * per snippet. This view lists them by thumbnail, page, and format, and builds the zip
 * in the sidebar with jszip, downloading it via an object-url anchor.
 */
import { useEffect, useState } from 'react';
import { LibraryBig } from 'lucide-react';
import JSZip from 'jszip';
import type { OutputFormat, SnippetRecord } from '../content/types';
import { EmptyState } from './EmptyState';
import { ViewLayout } from './ViewLayout';
import { clearSnippets, listSnippets } from '../utils/storage';
import { triggerDownload } from '../utils/download';
import { COLORS, FONT_UI, RADIUS, SURFACE } from '../theme';

const EXT: Record<OutputFormat, string> = {
	html: 'html', tailwind: 'html', 'bem-css': 'html', 'bem-scss': 'html',
	'jsx-tailwind': 'jsx', 'jsx-css': 'jsx', vue: 'vue',
};

export function SnippetList() {
	const [snippets, setSnippets] = useState<SnippetRecord[] | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		void listSnippets().then((s) => setSnippets(s.slice().reverse())); // Newest first
	}, []);

	if (!snippets) return <ViewLayout><div style={muted}>Loading…</div></ViewLayout>;
	if (snippets.length === 0) {
		return <ViewLayout><EmptyState Icon={LibraryBig} /></ViewLayout>;
	}

	const onExport = async (): Promise<void> => {
		setBusy(true);
		try {
			await exportZip(snippets);
		} finally {
			setBusy(false);
		}
	};

	const onClear = async (): Promise<void> => {
		await clearSnippets();
		setSnippets([]);
	};

	const footer = (
		<div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
			<button className="sc-btn sc-btn-primary" style={{ fontFamily: FONT_UI }} disabled={busy} onClick={() => void onExport()}>
				{busy ? 'Zipping…' : `Export All (${snippets.length})`}
			</button>
			<button className="sc-btn sc-btn-secondary" style={{ width: '100%', fontFamily: FONT_UI }} onClick={() => void onClear()}>
				Clear
			</button>
		</div>
	);

	return (
		<ViewLayout footer={footer}>
			{snippets.map((snip) => (
				<div key={snip.id} style={row}>
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
				</div>
			))}
		</ViewLayout>
	);
}

/** Build a zip with one folder per snippet, holding code, screenshot, and meta, and download it. */
async function exportZip(snippets: SnippetRecord[]): Promise<void> {
	const zip = new JSZip();
	snippets.forEach((snip, i) => {
		const folder = zip.folder(`${String(i + 1).padStart(2, '0')}-${slug(snip.page.title || 'snippet')}`);
		if (!folder) return;
		folder.file(`code.${EXT[snip.output.format]}`, snip.output.html);
		if (snip.output.css) folder.file('styles.css', snip.output.css);
		folder.file('meta.json', JSON.stringify({ page: snip.page, element: snip.element, format: snip.output.format, capturedAt: snip.capturedAt }, null, 2));
		const png = dataUrlToBase64(snip.screenshot);
		if (png) folder.file('screenshot.png', png, { base64: true });
	});
	const blob = await zip.generateAsync({ type: 'blob' });
	const url = URL.createObjectURL(blob);
	triggerDownload(url, 'snipcode-snippets.zip');
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Extract the base64 payload from a data url, or '' if not a data url. */
function dataUrlToBase64(dataUrl: string): string {
	const comma = dataUrl.indexOf(',');
	return dataUrl.startsWith('data:') && comma >= 0 ? dataUrl.slice(comma + 1) : '';
}

/** Filesystem-safe slug for a folder name. */
function slug(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'snippet';
}

const muted: React.CSSProperties = { color: COLORS.slate500, fontSize: '12px' };
const row: React.CSSProperties = {
	display: 'flex', gap: '10px', alignItems: 'center', padding: '8px', marginBottom: '8px',
	background: SURFACE.control, border: `1px solid ${SURFACE.border}`, borderRadius: `${RADIUS.lg}px`, fontSize: '12px',
};
const thumb: React.CSSProperties = { width: '40px', height: '40px', objectFit: 'cover', borderRadius: `${RADIUS.md}px`, flexShrink: 0, border: `1px solid ${SURFACE.border}` };
