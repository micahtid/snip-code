/**
 * inspect/types.ts: the contracts the page-scoped inspectors share
 *
 * Pipeline position: inspect, page-scoped; the shape every inspector emits, runs no element pipeline phase
 * Reads from DOM: nothing; type definitions
 * Writes to: nothing; type definitions
 *
 * Principles applied: none; type definitions.
 *
 * Why this exists: each of the four inspectors, fonts, assets, colors, and schema,
 * scans the whole page and ships one result to the side panel. Defining the report
 * records and the tagged InspectResult union in one place is what lets the content
 * script, the message ship, and the panel views agree on a shape without importing
 * each other. These are the v2-named, trimmed equivalents of v1's FontInfo /
 * AssetInfo / color cluster: only the fields a panel actually renders survive;
 * v1's extractionTime / totalElements / per-element debug lists are dropped.
 */

// The schema shape lives with its extractor; re-exported here so panel-
// side code can name a PageSchema without reaching into the schema subfolder.
export type { PageSchema } from './schema/types';

/** The four page scans the picker can start. */
export type ScanKind = 'fonts' | 'colors' | 'assets' | 'schema';

/** One weight + style combination a font family renders in. */
export interface FontVariant {
	weight: string;
	style: string;
}

/** A font family the page renders, most-used first. */
export interface FontReport {
	family: string;
	/** Web when the family is declared via @font-face / FontFaceSet; system otherwise. */
	origin: 'web' | 'system';
	usageCount: number;
	variants: FontVariant[];
}

/** The asset kinds the page-wide scan distinguishes: favicon, media, svg, and so on. */
export type AssetType = 'image' | 'css-bg' | 'inline-svg' | 'favicon' | 'video' | 'audio';

/**
 * One visual asset. `src` is the original url, absolutized, so the card can
 * preview it with a plain `<img>` and only fetch bytes on download; inline svgs
 * have no url and instead carry their truncated `markup`.
 */
export interface AssetReport {
	src: string;
	type: AssetType;
	filename: string;
	width?: number;
	height?: number;
	/** Serialized inline-svg markup, truncated for the thumbnail; inline svgs only. */
	markup?: string;
}

/** One color the page uses, most-used first; `role` is filled by the optional ai pass. */
export interface ColorReport {
	hex: string;
	count: number;
	role?: string;
}

/**
 * The discriminated result one scan ships to the panel; it is a sibling to
 * SnipResult, not part of the broker Envelope/Response union. The `kind` selects the
 * view. `aiEnhanced` records whether the optional byok pass ran, for colors and schema only.
 */
export type InspectResult =
	| { kind: 'fonts'; fonts: FontReport[]; warnings: string[] }
	| { kind: 'assets'; assets: AssetReport[]; warnings: string[] }
	| { kind: 'colors'; colors: ColorReport[]; aiEnhanced: boolean; warnings: string[] }
	| { kind: 'schema'; json: string; aiEnhanced: boolean; warnings: string[] };
