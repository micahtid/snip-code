/**
 * inspect/assets.ts: page-wide asset extractor
 *
 * Pipeline position: inspect, page-scoped; reads the live dom directly and does not run the element pipeline
 * Reads from DOM: document/window; live, the page must be loaded
 * Writes to: nothing; pure extraction, no side effects
 *
 * Principles applied: none; extraction.
 *
 * Why this exists: the assets inspector lists every image, media file, css
 * background, favicon, and inline svg the page uses so the panel can preview each
 * and download it. Each record carries the original url, so the card previews it
 * with a plain `<img>` and only fetches bytes on download; inline svgs have no url,
 * so their truncated markup rides along instead. Ported by rewriting from v1
 * assets/asset-extractor.ts, dropping the class/logger ceremony and the mime /
 * byte-size / source-element fields the panel never showed.
 */
import type { AssetReport, AssetType } from './types';
import { toAbsoluteUrl } from '../../utils/url';

/** Non-asset tags skipped when scanning computed background-image. */
const SKIP_TAGS = new Set(['SCRIPT', 'NOSCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META', 'HEAD', 'BASE']);

/** Attributes lazy-loaders stash the real url in before swapping it into src. */
const LAZY_ATTRS = ['data-src', 'data-lazy', 'data-original', 'data-srcset'];

/** Caps so a media-heavy page cannot stall the scan or ship oversized markup. */
const MAX_BG_ELEMENTS = 1500;
const MIN_SVG_SIZE = 4; // px; smaller svgs are decorative glyphs, not assets
const MAX_SVG_MARKUP = 50000; // chars; larger svgs are maps/charts, skipped
const SVG_THUMB_CHARS = 2000; // truncation for the shipped thumbnail markup

/** Collects every visual asset on the page, in discovery order, deduped. */
export function extractPageAssets(): AssetReport[] {
	const base = document.baseURI || location.href;
	const assets: AssetReport[] = [];
	const seen = new Set<string>();

	const add = (asset: AssetReport): void => {
		const key = asset.src || asset.markup?.slice(0, 100) || '';
		if (!key || seen.has(key)) return;
		seen.add(key);
		assets.push(asset);
	};

	/** Record a url-bearing asset, absolutized; data: and unparseable urls are dropped. */
	const addUrl = (raw: string, type: AssetType, width?: number, height?: number): void => {
		if (!raw || raw.startsWith('data:')) return;
		const src = toAbsoluteUrl(raw, base);
		if (src) add({ src, type, filename: filenameOf(src), ...dims(width, height) });
	};

	collectImages(addUrl);
	collectPictureSources(addUrl);
	collectMedia(addUrl);
	collectBackgrounds(addUrl);
	collectInlineSvgs(add);
	collectFavicons(addUrl);

	return assets;
}

/** <img> primary src, responsive srcset, and lazy-loaded url attributes. */
function collectImages(addUrl: AddUrl): void {
	for (const img of Array.from(document.querySelectorAll('img'))) {
		const src = img.currentSrc || img.src;
		addUrl(src, 'image', img.naturalWidth || undefined, img.naturalHeight || undefined);
		for (const url of parseSrcset(img.srcset)) addUrl(url, 'image');
		for (const attr of LAZY_ATTRS) {
			const val = img.getAttribute(attr);
			if (val?.startsWith('http')) addUrl(val, 'image');
		}
	}
}

/** Records one url-bearing asset, optionally with its pixel dimensions. */
type AddUrl = (raw: string, type: AssetType, width?: number, height?: number) => void;

/** <picture> > <source> srcset candidates. */
function collectPictureSources(addUrl: AddUrl): void {
	for (const source of Array.from(document.querySelectorAll('picture source'))) {
		for (const url of parseSrcset(source.getAttribute('srcset') ?? '')) addUrl(url, 'image');
	}
}

/** <video>/<audio> sources, a video poster image, and child <source> elements. */
function collectMedia(addUrl: AddUrl): void {
	for (const media of Array.from(document.querySelectorAll('video, audio'))) {
		const kind: AssetType = media.tagName === 'VIDEO' ? 'video' : 'audio';
		const el = media as HTMLMediaElement;
		if (el.src) addUrl(el.src, kind);
		if (media instanceof HTMLVideoElement && media.poster) addUrl(media.poster, 'image');
		for (const source of Array.from(media.querySelectorAll('source'))) {
			if (source.src) addUrl(source.src, kind);
		}
	}
}

/** Computed background-image url()s across the page, capped. */
function collectBackgrounds(addUrl: AddUrl): void {
	const elements = document.querySelectorAll('*');
	const limit = Math.min(elements.length, MAX_BG_ELEMENTS);
	for (let i = 0; i < limit; i++) {
		const el = elements[i]!;
		if (SKIP_TAGS.has(el.tagName)) continue;
		const bg = getComputedStyle(el).backgroundImage;
		if (!bg || bg === 'none') continue;
		for (const url of urlsInCss(bg)) addUrl(url, 'css-bg');
	}
}

/** Inline <svg> elements, serialized and truncated for a thumbnail. */
function collectInlineSvgs(add: (asset: AssetReport) => void): void {
	const serializer = new XMLSerializer();
	let n = 0;
	for (const svg of Array.from(document.querySelectorAll('svg'))) {
		const rect = svg.getBoundingClientRect();
		if (rect.width < MIN_SVG_SIZE || rect.height < MIN_SVG_SIZE) continue;
		const markup = serializer.serializeToString(svg);
		if (markup.length > MAX_SVG_MARKUP) continue;
		n++;
		add({
			src: '',
			type: 'inline-svg',
			filename: `inline-svg-${n}`,
			...dims(Math.round(rect.width) || undefined, Math.round(rect.height) || undefined),
			markup: markup.slice(0, SVG_THUMB_CHARS),
		});
	}
}

/** <link rel="...icon..."> favicons. */
function collectFavicons(addUrl: AddUrl): void {
	for (const link of Array.from(document.querySelectorAll('link[rel*="icon"]'))) {
		const href = link.getAttribute('href');
		if (href) addUrl(href, 'favicon');
	}
}

/** A dimensions object carrying only the values that are known, with no undefined keys. */
function dims(width?: number, height?: number): { width?: number; height?: number } {
	const out: { width?: number; height?: number } = {};
	if (width) out.width = width;
	if (height) out.height = height;
	return out;
}

/** The decoded last path segment of a url, capped; 'unknown' if unparseable. */
function filenameOf(url: string): string {
	try {
		const last = new URL(url).pathname.split('/').pop();
		return last ? decodeURIComponent(last).slice(0, 60) : 'unknown';
	} catch {
		return 'unknown';
	}
}

/** The url of each srcset candidate: the first token of each comma-separated entry. */
function parseSrcset(srcset: string): string[] {
	if (!srcset) return [];
	return srcset.split(',').map((entry) => entry.trim().split(/\s+/)[0] ?? '').filter(Boolean);
}

/** Non-data url() targets inside a css value. */
function urlsInCss(value: string): string[] {
	const urls: string[] = [];
	const re = /url\(["']?([^"')]+)["']?\)/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(value)) !== null) {
		const url = match[1]!.trim();
		if (url && !url.startsWith('data:')) urls.push(url);
	}
	return urls;
}
