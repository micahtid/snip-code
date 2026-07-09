/**
 * utils/download.ts: save a same-origin blob or data url to disk.
 *
 * This is not part of the pipeline. It is a cross-cutting ui utility.
 *
 * Why this exists: several panel views, such as the result viewer, the schema view, and the
 * snippet exporter, save a blob or data url the same way, via a transient anchor click. This
 * was duplicated inline in each, so it lives here once. NOTE: this is for same-origin blob
 * and data downloads only. A cross-origin asset url is opened in a new tab instead, using a
 * deliberately different anchor in components/inspect/AssetGrid.tsx, so those are not routed
 * through here.
 */

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
