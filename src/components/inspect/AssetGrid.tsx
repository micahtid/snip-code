/**
 * components/inspect/AssetGrid.tsx: the assets inspector view
 *
 * Pipeline position: n/a, ui only
 * Reads from Captured: n/a
 * Writes to Captured: n/a
 *
 * Principles applied: none, ui only.
 *
 * Why this exists: renders the page's images, media, backgrounds, favicons, and
 * inline svgs as a grid of thumbnail cards showing the filename, type, and
 * dimensions. Clicking a card downloads the asset: remote urls download directly,
 * inline svgs download their serialized markup as a .svg file.
 */
import { useState } from 'react';
import { Image as ImageIcon } from 'lucide-react';
import type { AssetReport } from '../../content/inspect/types';
import { COLORS } from '../../theme';
import { InspectCard } from './InspectCard';

export function AssetGrid({ assets }: { assets: AssetReport[] }) {
	return (
		<div className="sc-inspect-grid">
			{assets.map((asset, i) => (
				<InspectCard
					key={asset.src || `inline-svg-${i}`}
					preview={<AssetThumb asset={asset} />}
					name={asset.filename}
					meta={metaOf(asset)}
					onActivate={() => downloadAsset(asset)}
					feedback="Downloaded"
					title={`Download ${asset.filename}`}
				/>
			))}
		</div>
	);
}

/** The thumbnail: inline-svg markup, the remote image, or a fallback icon on load failure. */
function AssetThumb({ asset }: { asset: AssetReport }) {
	const [failed, setFailed] = useState(false);
	if (asset.type === 'inline-svg' && asset.markup) {
		return <span className="sc-asset-svg" dangerouslySetInnerHTML={{ __html: asset.markup }} />;
	}
	if (asset.src && !failed) {
		return <img className="sc-asset-thumb" src={asset.src} alt={asset.filename} onError={() => setFailed(true)} />;
	}
	return <ImageIcon size={18} color={COLORS.slate400} />;
}

/** The meta line: the asset type plus its pixel dimensions when known. */
function metaOf(asset: AssetReport): string {
	const dims = asset.width && asset.height ? ` · ${asset.width}×${asset.height}` : '';
	return `${asset.type}${dims}`;
}

/** Downloads one asset via a transient anchor; inline svgs become a blob .svg. */
function downloadAsset(asset: AssetReport): void {
	if (asset.type === 'inline-svg' && asset.markup) {
		const url = URL.createObjectURL(new Blob([asset.markup], { type: 'image/svg+xml' }));
		const name = asset.filename.endsWith('.svg') ? asset.filename : `${asset.filename}.svg`;
		triggerDownload(url, name);
		URL.revokeObjectURL(url);
		return;
	}
	if (asset.src) triggerDownload(asset.src, asset.filename);
}

/** Click a temporary anchor to start a download without leaving the panel. */
function triggerDownload(href: string, filename: string): void {
	const a = document.createElement('a');
	a.href = href;
	a.download = filename;
	a.target = '_blank';
	a.rel = 'noopener noreferrer';
	a.click();
}
