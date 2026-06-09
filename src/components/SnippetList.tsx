/**
 * components/SnippetList.tsx — saved-snippets view
 *
 * Phase: k (ship) — see SNIPCODE-REWRITE-PLAN.md section 12
 * Pipeline position: n/a (reads stored SnippetRecord[], section 19.10)
 * Reads from Captured: n/a
 * Writes to Captured: n/a
 *
 * Principles applied: none (ui).
 *
 * Why this exists: snipcode keeps the last 50 snippets in chrome.storage.local
 * (fifo, decision 12) and offers one-click "export all" to a zip with one folder
 * per snippet. this view lists them (thumbnail + page + format) and builds the zip
 * in the sidebar (jszip), downloading it via an object-url anchor.
 */
import { useEffect, useState } from 'react';
import JSZip from 'jszip';
import type { OutputFormat, SnippetRecord } from '../content/types';
import { clearSnippets, listSnippets } from '../utils/storage';

const EXT: Record<OutputFormat, string> = {
	html: 'html', tailwind: 'html', 'bem-css': 'html', 'bem-scss': 'html',
	'jsx-tailwind': 'jsx', 'jsx-css': 'jsx', vue: 'vue',
};

export function SnippetList() {
	const [snippets, setSnippets] = useState<SnippetRecord[] | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		void listSnippets().then((s) => setSnippets(s.slice().reverse())); // newest first
	}, []);

	if (!snippets) return <div style={{ color: '#999' }}>loading…</div>;
	if (snippets.length === 0) return <div style={{ color: '#999', fontSize: '12px' }}>no saved snippets yet.</div>;

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

	return (
		<div>
			<div style={{ display: 'flex', gap: '6px', marginBottom: '10px' }}>
				<button style={btn} disabled={busy} onClick={() => void onExport()}>
					{busy ? 'zipping…' : `export all (${snippets.length})`}
				</button>
				<button style={{ ...btn, background: '#eee', color: '#444' }} onClick={() => void onClear()}>
					clear
				</button>
			</div>
			{snippets.map((snip) => (
				<div key={snip.id} style={row}>
					{snip.screenshot ? (
						<img src={snip.screenshot} alt="" style={thumb} />
					) : (
						<div style={{ ...thumb, background: '#f3f3f3' }} />
					)}
					<div style={{ overflow: 'hidden' }}>
						<div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
							{snip.page.title || snip.page.url}
						</div>
						<div style={{ color: '#888', fontSize: '11px' }}>
							{snip.output.format} · {new Date(snip.capturedAt).toLocaleString()}
						</div>
					</div>
				</div>
			))}
		</div>
	);
}

/** build a zip with one folder per snippet (code + screenshot + meta) and download it. */
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
	const a = document.createElement('a');
	a.href = url;
	a.download = 'snipcode-snippets.zip';
	a.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** extract the base64 payload from a data url, or '' if not a data url. */
function dataUrlToBase64(dataUrl: string): string {
	const comma = dataUrl.indexOf(',');
	return dataUrl.startsWith('data:') && comma >= 0 ? dataUrl.slice(comma + 1) : '';
}

/** filesystem-safe slug for a folder name. */
function slug(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'snippet';
}

const btn: React.CSSProperties = { padding: '6px 10px', border: 'none', borderRadius: '6px', background: '#4f6ef6', color: '#fff', cursor: 'pointer' };
const row: React.CSSProperties = { display: 'flex', gap: '8px', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #f0f0f0', fontSize: '12px' };
const thumb: React.CSSProperties = { width: '40px', height: '40px', objectFit: 'cover', borderRadius: '4px', flexShrink: 0, border: '1px solid #eee' };
