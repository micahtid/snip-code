/**
 * inspect/colors.ts: page-wide color extractor
 *
 * Pipeline position: inspect, page-scoped. It reads the live dom directly and does not run the element pipeline.
 * Reads from DOM: document/window. This runs live, so the page must be loaded.
 * Writes to: nothing. This is pure extraction with no side effects.
 *
 * Principles applied: none. This is extraction.
 *
 * Why this exists: the colors inspector lists every color the page paints,
 * perceptually clustered so near-duplicate shades collapse into one swatch, most-
 * used first. Clustering is greedy in Oklab space, the perceptually uniform color
 * model, so visually identical colors that differ by a hex digit merge while
 * distinct colors stay apart. The color-valued css custom properties ride along as
 * context for the optional ai role pass (inspect/ai.ts). Ported by rewriting from v1
 * colors/color-extractor.ts, preserving the Oklab clustering verbatim and dropping
 * the per-element / oklch / member-count fields the panel never showed.
 */
import type { ColorReport } from './types';

/** Paint properties whose computed value is a single color. */
const COLOR_PROPERTIES = [
	'color', 'background-color',
	'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
	'outline-color', 'text-decoration-color', 'fill', 'stroke',
];

/** Non-paint tags skipped during the walk. */
const SKIP_TAGS = new Set(['SCRIPT', 'NOSCRIPT', 'STYLE', 'TEMPLATE', 'IFRAME', 'LINK', 'META', 'HEAD', 'BASE', 'BR', 'WBR']);

/** Values that carry no palette signal: fully transparent, absent, or keyword. */
const IGNORE_COLORS = new Set(['rgba(0, 0, 0, 0)', 'transparent', 'initial', 'inherit', 'currentcolor']);

/** Caps mirrored from v1: the walk, the shadow-color pass, and the shipped swatch count. */
const MAX_ELEMENTS = 2000;
const MAX_SHADOW_ELEMENTS = 500;
const MAX_SWATCHES = 30;

/** Greedy Oklab merge distance; below this, two colors are one swatch. */
const CLUSTER_THRESHOLD = 0.04;

/** One distinct color and how many elements paint with it. */
interface RawColor {
	hex: string;
	rgb: { r: number; g: number; b: number };
	count: number;
}

/** The colors inspector result: clustered swatches plus the css color variables. */
export interface ColorExtraction {
	colors: ColorReport[];
	cssVariables: Record<string, string>;
}

/** Collects the page's colors, perceptually clustered and most-used first. */
export function extractPageColors(): ColorExtraction {
	const raw = new Map<string, RawColor>();
	walkPaintColors(raw);
	addShadowColors(raw);

	const clustered = clusterColors([...raw.values()]).slice(0, MAX_SWATCHES);
	return { colors: clustered, cssVariables: collectColorVariables() };
}

/** Walks the dom and tallies every non-transparent paint color by hex. */
function walkPaintColors(raw: Map<string, RawColor>): void {
	const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
		acceptNode: (node) => (SKIP_TAGS.has((node as Element).tagName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
	});

	let seen = 0;
	for (let node = walker.nextNode(); node && seen < MAX_ELEMENTS; node = walker.nextNode()) {
		seen++;
		const style = getComputedStyle(node as Element);
		for (const prop of COLOR_PROPERTIES) {
			tally(raw, parseColor(style.getPropertyValue(prop)));
		}
	}
}

/** Adds the colors embedded in box-shadow / text-shadow values, capped. */
function addShadowColors(raw: Map<string, RawColor>): void {
	const elements = document.querySelectorAll('*');
	const limit = Math.min(elements.length, MAX_SHADOW_ELEMENTS);
	for (let i = 0; i < limit; i++) {
		const style = getComputedStyle(elements[i]!);
		for (const prop of ['box-shadow', 'text-shadow']) {
			const value = style.getPropertyValue(prop);
			if (!value || value === 'none') continue;
			for (const colorStr of value.match(/rgba?\([^)]+\)/g) ?? []) {
				tally(raw, parseColor(colorStr));
			}
		}
	}
}

/** Records one parsed color against its hex, incrementing the usage count. */
function tally(raw: Map<string, RawColor>, parsed: { r: number; g: number; b: number } | null): void {
	if (!parsed) return;
	const hex = rgbToHex(parsed.r, parsed.g, parsed.b);
	const existing = raw.get(hex);
	if (existing) existing.count++;
	else raw.set(hex, { hex, rgb: parsed, count: 1 });
}

/** Color-valued css custom properties declared on :root / html, the named tokens. */
function collectColorVariables(): Record<string, string> {
	const vars: Record<string, string> = {};
	const rootStyle = getComputedStyle(document.documentElement);
	for (const sheet of Array.from(document.styleSheets)) {
		let rules: CSSRuleList;
		try {
			rules = sheet.cssRules;
		} catch {
			continue; // Cross-origin stylesheet, not readable here.
		}
		for (const rule of Array.from(rules)) {
			if (!(rule instanceof CSSStyleRule) || (rule.selectorText !== ':root' && rule.selectorText !== 'html')) continue;
			for (let i = 0; i < rule.style.length; i++) {
				const prop = rule.style[i]!;
				if (!prop.startsWith('--')) continue;
				const value = rootStyle.getPropertyValue(prop).trim();
				if (value && looksLikeColor(value)) vars[prop] = value;
			}
		}
	}
	return vars;
}

/** Whether a css value is a color, tested by the browser's own parser, the ground truth. */
function looksLikeColor(value: string): boolean {
	return CSS.supports('color', value);
}

/**
 * Greedy perceptual clustering in Oklab space. Colors are processed most-frequent
 * first so the most common shade seeds each cluster. A color within the threshold
 * of a cluster's running centroid merges into it, otherwise it starts a new one.
 */
function clusterColors(colors: RawColor[]): ColorReport[] {
	interface Cluster {
		hex: string; // The representative color's hex, the most frequent one.
		centroid: { L: number; a: number; b: number };
		members: Array<{ L: number; a: number; b: number }>;
		count: number;
	}
	const clusters: Cluster[] = [];
	const sorted = [...colors].sort((a, b) => b.count - a.count);

	for (const color of sorted) {
		const lab = rgbToOklab(color.rgb.r, color.rgb.g, color.rgb.b);
		const near = clusters.find((c) => oklabDistance(c.centroid, lab) < CLUSTER_THRESHOLD);
		if (near) {
			near.members.push(lab);
			near.count += color.count;
			near.centroid = {
				L: near.members.reduce((s, m) => s + m.L, 0) / near.members.length,
				a: near.members.reduce((s, m) => s + m.a, 0) / near.members.length,
				b: near.members.reduce((s, m) => s + m.b, 0) / near.members.length,
			};
		} else {
			clusters.push({ hex: color.hex, centroid: lab, members: [lab], count: color.count });
		}
	}

	return clusters.map((c) => ({ hex: c.hex, count: c.count })).sort((a, b) => b.count - a.count);
}

/**
 * Parses a css color to rgb, dropping near-transparent values. The rgb/rgba fast
 * path covers computed styles, which are always serialized that way. Named colors and other
 * notations fall back to a 1x1 canvas paint.
 */
function parseColor(cssColor: string): { r: number; g: number; b: number } | null {
	const value = cssColor?.trim();
	if (!value || IGNORE_COLORS.has(value.toLowerCase())) return null;

	const rgba = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
	if (rgba) {
		const a = rgba[4] !== undefined ? parseFloat(rgba[4]) : 1;
		if (a < 0.05) return null; // Effectively transparent, so it carries no palette signal.
		return { r: parseInt(rgba[1]!), g: parseInt(rgba[2]!), b: parseInt(rgba[3]!) };
	}

	try {
		const canvas = document.createElement('canvas');
		canvas.width = canvas.height = 1;
		const ctx = canvas.getContext('2d');
		if (!ctx) return null;
		ctx.fillStyle = value;
		ctx.fillRect(0, 0, 1, 1);
		const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data as unknown as [number, number, number, number];
		if (a < 13) return null; // ~5% alpha, effectively transparent.
		return { r, g, b };
	} catch {
		return null;
	}
}

/** Two-digit hex string for an rgb triple. */
function rgbToHex(r: number, g: number, b: number): string {
	return '#' + [r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('');
}

/** sRGB channel [0-255] to linear-light [0-1]. */
function srgbToLinear(c: number): number {
	const s = c / 255;
	return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** RGB to Oklab, the perceptually uniform model clustering measures distance in. */
function rgbToOklab(r: number, g: number, b: number): { L: number; a: number; b: number } {
	const lr = srgbToLinear(r);
	const lg = srgbToLinear(g);
	const lb = srgbToLinear(b);
	const l_ = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
	const m_ = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
	const s_ = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
	return {
		L: 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
		a: 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
		b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
	};
}

/** Euclidean distance in Oklab space. */
function oklabDistance(a: { L: number; a: number; b: number }, b: { L: number; a: number; b: number }): number {
	return Math.sqrt((a.L - b.L) ** 2 + (a.a - b.a) ** 2 + (a.b - b.b) ** 2);
}
