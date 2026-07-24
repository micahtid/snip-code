/**
 * utils/download.ts: save a same-origin blob or data url to disk.
 *
 * This is not part of the pipeline. It is a cross-cutting ui utility.
 *
 * Why this exists: several panel views, such as the result viewer, the schema view, and the
 * snippet exporter, save a blob or data url the same way, via a transient anchor click, and
 * two of them additionally zip a set of files first. This was duplicated inline in each, so
 * the anchor click, the object-url lifecycle, and the zip build all live here once. NOTE: this is for same-origin blob
 * and data downloads only. A cross-origin asset url is opened in a new tab instead, using a
 * deliberately different anchor in components/inspect/AssetGrid.tsx, so those are not routed
 * through here.
 */

import JSZip from 'jszip';

/** One file in a zip. Text files carry `text`, binary files carry a base64 payload. */
export interface ZipEntry {
	/** Path inside the zip, folders included, such as 'component-1/index.html'. */
	path: string;
	text?: string;
	base64?: string;
}

/**
 * Build a zip from a flat list of entries. Folders come from the '/' separators in each
 * path, so a caller groups files by naming them, not by walking a folder api. Entries with
 * neither text nor base64 are skipped rather than written empty.
 *
 * @param entries - the files to write, in order
 * @returns the zip as a blob
 */
export async function buildZip(entries: ZipEntry[]): Promise<Blob> {
	const zip = new JSZip();
	for (const entry of entries) {
		if (entry.base64) zip.file(entry.path, entry.base64, { base64: true });
		else if (entry.text !== undefined) zip.file(entry.path, entry.text);
	}
	return await zip.generateAsync({ type: 'blob' });
}

/**
 * Zip a set of files and save the archive to disk. One prompt instead of one per file,
 * which is why a multi-file download is always an archive.
 *
 * @param name - the archive file name
 * @param entries - the files to write into it
 */
export async function downloadZip(name: string, entries: ZipEntry[]): Promise<void> {
	downloadBlob(await buildZip(entries), name);
}

/** The base64 payload of a data url, or '' when the string is not a data url. */
export function dataUrlToBase64(dataUrl: string): string {
	const comma = dataUrl.indexOf(',');
	return dataUrl.startsWith('data:') && comma >= 0 ? dataUrl.slice(comma + 1) : '';
}

/** How long an object url stays alive after the click, long enough for the browser to read it. */
const REVOKE_MS = 30_000;

/**
 * Save a blob to disk under `name`, via a transient object url that is revoked once the
 * browser has had time to read it.
 *
 * @param blob - the bytes to save
 * @param name - the file name the browser saves it under
 */
export function downloadBlob(blob: Blob, name: string): void {
	const url = URL.createObjectURL(blob);
	triggerDownload(url, name);
	setTimeout(() => URL.revokeObjectURL(url), REVOKE_MS);
}

/** Trigger a browser download of `href` saved as `name`, via a transient anchor click. */
export function triggerDownload(href: string, name: string): void {
	const a = document.createElement('a');
	a.href = href;
	a.download = name;
	a.rel = 'noopener';
	document.body.appendChild(a);
	a.click();
	a.remove();
}
