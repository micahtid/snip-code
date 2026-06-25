/**
 * inspect/schema/types.ts: the page-schema contracts
 *
 * Pipeline position: inspect (page-scoped; the shape the schema extractor emits)
 * Reads from DOM: nothing (type definitions)
 * Writes to: nothing (type definitions)
 *
 * Principles applied: none (type definitions).
 *
 * Why this exists: the style-json inspector walks the page and produces a
 * compressed design-system schema, the PageSchema below. Defining its shape and
 * every sub-type in one place lets the extractor, the optimizer, and the ai pass
 * agree on the contract. Ported from v1 schema/types.ts (the output types only;
 * v1's re-exports of capture-side types are dropped, the extractor reads the live
 * dom directly).
 */

/** One color the page uses, with the css contexts it appears in and a usage count. */
export interface ColorEntry {
	value: string;
	contexts: string[];
	count: number;
}

/** One font family, with the sizes and weights it renders in and an inferred usage. */
export interface FontEntry {
	family: string;
	sizes: string[];
	weights: number[];
	usage: string;
}

/** One node in the compressed structure tree (style ref + optional repeat/text). */
export interface SchemaNode {
	tag: string;
	role: string;
	s?: string; // Style map reference (e.g. "s1").
	children?: SchemaNode[];
	repeat?: number; // Collapsed sibling count.
	text?: string; // Placeholder like "{h1}", "{p}", "{btn}".
}

/** A repeated element pattern (3+ identical role+style elements). */
export interface ComponentPattern {
	name: string;
	role: string;
	count: number;
	structure: SchemaNode;
	styleRefs: string[];
}

/** One interactive-state rule lifted from the stylesheets. */
export interface StateRule {
	selector: string;
	state: 'hover' | 'focus' | 'active' | 'focus-visible';
	changes: Record<string, string>;
}

/** The semantic kinds a top-level section is classified into. */
export type SectionType =
	| 'nav' | 'hero' | 'features' | 'how-it-works' | 'testimonials'
	| 'pricing' | 'faq' | 'cta' | 'footer' | 'stats' | 'logos'
	| 'gallery' | 'content' | 'unknown';

/** The layout shapes a section's content can take. */
export type LayoutPattern =
	| 'centered-stack' | 'two-column' | 'two-column-reverse'
	| 'grid-2' | 'grid-3' | 'grid-4' | 'grid-n'
	| 'horizontal-scroll' | 'single-column' | 'split'
	| 'unknown';

/** One top-level section's composition: type, layout, and the elements it contains. */
export interface SectionBlueprint {
	type: SectionType;
	tag: string;
	layout: LayoutPattern;
	alignment: 'left' | 'center' | 'right';
	background: string; // Bg color or "transparent".
	elements: string[]; // Ordered, e.g. ["badge", "heading", "subtext", "button-pair", "image"].
	gridColumns?: number;
	maxWidth?: string;
	gap?: string;
	padding?: string;
}

/** A recurring element grouping across sections (e.g. "heading+text+cta"). */
export interface ContentGrouping {
	pattern: string;
	occurrences: number;
	elements: string[];
}

/** One button variant's full visual spec, including hover/active states. */
export interface ButtonBlueprint {
	variant: string; // "primary", "secondary", "ghost", etc.
	bg: string;
	color: string;
	borderRadius: string;
	padding: string;
	fontWeight: number;
	fontSize: string;
	border: string;
	shadow: string;
	hover: Record<string, string>;
	active: Record<string, string>;
	styleTag: string; // "flat", "pressed-3d", "gradient", "outline", "ghost", "elevated".
}

/** One card variant's visual spec plus its inner layout. */
export interface CardBlueprint {
	bg: string;
	borderRadius: string;
	shadow: string;
	border: string;
	padding: string;
	hover: Record<string, string>;
	innerLayout: string; // E.g. "image + heading + text + button".
}

/** The page navigation's spec. */
export interface NavBlueprint {
	bg: string;
	position: string;
	height: string;
	blur: boolean; // Has backdrop-filter blur.
	border: string;
	layout: string; // E.g. "logo-left + links-center + cta-right".
	linkCount: number;
}

/** The page's decorative language: blobs, gradients, illustration style, accents. */
export interface DecorativeInfo {
	hasBlobs: boolean;
	hasGradientBgs: boolean;
	hasPatterns: boolean;
	illustrationStyle: string; // "none", "icon-based", "photo", "mixed".
	svgRatio: number;
	photoRatio: number;
	backgroundEffects: string[];
	accentTreatments: string[];
}

/** The page's responsive behavior, read from media queries. */
export interface ResponsiveInfo {
	breakpoints: string[];
	mobileNavStyle: string; // "hamburger", "bottom-tab", "hidden", "unchanged".
	gridCollapseBehavior: string; // "stack", "scroll", "reduce-columns".
}

/** The complete compressed design-system schema for one page. */
export interface PageSchema {
	meta: {
		url: string;
		title: string;
		viewport: { w: number; h: number };
	};
	tokens: {
		colors: ColorEntry[];
		fonts: FontEntry[];
		spacing: string[];
		radii: string[];
		shadows: string[];
		spacingAnalysis?: { baseUnit: number; gridCompliance: number; offGrid: string[] };
		scaleAnalysis?: { ratio: number; name: string; base: number; deviation: number };
		consistency?: { colors: number; spacing: number; radii: number; shadows: number; issues: string[] };
	};
	styles: Record<string, Record<string, string>>;
	structure: SchemaNode[];
	components: ComponentPattern[];
	states: StateRule[];
	sections: SectionBlueprint[];
	contentPatterns: ContentGrouping[];
	buttons: ButtonBlueprint[];
	cards: CardBlueprint[];
	nav: NavBlueprint | null;
	decorative: DecorativeInfo;
	responsive: ResponsiveInfo;
}
