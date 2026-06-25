/**
 * inspect/schema/extract.ts: the page-schema extractor
 *
 * Pipeline position: inspect (page-scoped; reads the live dom directly, does not run the element pipeline)
 * Reads from DOM: document/window (live; the whole page must be loaded)
 * Writes to: nothing (pure extraction, returns a PageSchema)
 *
 * Principles applied: none (extraction).
 *
 * Why this exists: the style-json inspector turns a whole page into a compressed
 * design-system schema. It walks the visible dom (stratified by section so a long
 * page samples evenly), collects the color / font / spacing / radius / shadow
 * tokens, dedupes elements into a style map and a structure tree, lifts
 * interactive-state rules from the readable stylesheets, and detects section and
 * component (button / card / nav) blueprints plus the page's decorative and
 * responsive language. The result is optimized (inspect/schema/optimize.ts) and,
 * with a key, synthesized by the ai pass (inspect/ai.ts). Ported (rewritten) from
 * v1 schema/schema-extractor.ts as plain functions, dropping the class/logger
 * ceremony and v1's discarded root-variable pass; cross-origin stylesheets are read
 * only when same-origin-readable, matching the other page-scoped inspectors.
 */
import { computeFingerprint } from './fingerprint';
import { classifyElement, classNameOf, isElementVisible, SKIP_TAGS, type SemanticRole } from './classify';
import type {
	PageSchema, SchemaNode, ComponentPattern, StateRule,
	ColorEntry, FontEntry, SectionBlueprint, SectionType, LayoutPattern,
	ContentGrouping, ButtonBlueprint, CardBlueprint, NavBlueprint,
	DecorativeInfo, ResponsiveInfo,
} from './types';

/** One element captured by the walk, with its role, fingerprint, and tree position. */
interface WalkedElement {
	element: Element;
	tag: string;
	role: SemanticRole;
	fingerprint: string;
	properties: Record<string, string>;
	parent: Element | null;
	depth: number;
	pseudoColors?: string[];
	repeat?: number; // Collapsed identical-sibling count, filled during dedup.
}

const COLOR_PROPS = ['color', 'background-color', 'border-color', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'];
const SPACING_PROPS = ['padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'gap'];

/** Selectors for third-party widgets (chat, cookie, analytics) to skip during the walk. */
const THIRD_PARTY_BLOCKLIST = [
	'[class*="intercom"]', '[id*="cookie"]', '[data-ad]', '[class*="grecaptcha"]',
	'[class*="hotjar"]', '[id*="onetrust"]', '[class*="drift"]', '[class*="hubspot"]',
	'[class*="crisp"]', '[id*="fb-root"]', '[class*="livechat"]', '[class*="zendesk"]',
	'[class*="tawk"]', '[id*="chatlio"]',
];

/** Known modular type-scale ratios, fitted against the page's font sizes. */
const MODULAR_SCALES: Array<{ name: string; ratio: number }> = [
	{ name: 'Minor Second', ratio: 1.067 },
	{ name: 'Major Second', ratio: 1.125 },
	{ name: 'Minor Third', ratio: 1.2 },
	{ name: 'Major Third', ratio: 1.25 },
	{ name: 'Perfect Fourth', ratio: 1.333 },
	{ name: 'Augmented Fourth', ratio: 1.414 },
	{ name: 'Perfect Fifth', ratio: 1.5 },
	{ name: 'Golden Ratio', ratio: 1.618 },
];

/** Builds the complete page schema from the live dom. */
export function extractPageSchema(): PageSchema {
	const walked = walkDOM();
	const rules = readableRules();

	const colors = collectColors(walked);
	const fonts = collectFonts(walked);
	const spacing = collectSpacing(walked);
	const radii = collectValues(walked, 'br');
	const shadows = collectShadows(walked);

	const spacingAnalysis = analyzeSpacingBaseUnit(spacing);
	const scaleAnalysis = detectTypographyScale(fonts);

	const { deduplicated, components } = detectPatterns(walked);
	const states = extractStates(rules, walked);
	const { styles, structure } = assemble(deduplicated);

	const sections = extractSections();
	const contentPatterns = extractContentPatterns(sections);

	const buttons = extractButtonBlueprints(walked, states);
	const cards = extractCardBlueprints(walked, states);
	const nav = extractNavBlueprint();
	const decorative = extractDecorativeInfo();
	const responsive = extractResponsiveInfo(rules);

	const consistency = analyzeConsistency(colors, radii, shadows, spacingAnalysis);

	return {
		meta: {
			url: window.location.href,
			title: document.title,
			viewport: { w: window.innerWidth, h: window.innerHeight },
		},
		tokens: {
			colors, fonts, spacing, radii, shadows,
			...(spacingAnalysis ? { spacingAnalysis } : {}),
			...(scaleAnalysis ? { scaleAnalysis } : {}),
			...(consistency ? { consistency } : {}),
		},
		styles,
		structure,
		components,
		states,
		sections,
		contentPatterns,
		buttons,
		cards,
		nav,
		decorative,
		responsive,
	};
}

/** Top-level css rules from every same-origin-readable stylesheet. */
function readableRules(): CSSRule[] {
	const out: CSSRule[] = [];
	for (const sheet of Array.from(document.styleSheets)) {
		let rules: CSSRuleList;
		try {
			rules = sheet.cssRules;
		} catch {
			continue; // Cross-origin stylesheet; not readable here.
		}
		for (const rule of Array.from(rules)) out.push(rule);
	}
	return out;
}

// ---------------------------------------------------------------------------
// DOM walk (stratified, visible elements only)
// ---------------------------------------------------------------------------

/**
 * Walks the visible dom, capturing each element's role, fingerprint, and tree
 * position. Sampling is stratified: each top-level section gets a share of the
 * element budget proportional to its size, so a long section cannot crowd out the
 * rest. Once a section exceeds its budget it is sampled every third element.
 */
function walkDOM(): WalkedElement[] {
	const elements: WalkedElement[] = [];
	const MAX_ELEMENTS = 1500;

	const isThirdParty = (el: Element): boolean => {
		for (const selector of THIRD_PARTY_BLOCKLIST) {
			try {
				if (el.matches(selector)) return true;
			} catch {
				// Invalid selector; skip it.
			}
		}
		return el.ownerDocument !== document; // Inside an iframe.
	};

	// First pass: size each top-level section so the budget can be split proportionally.
	const topSections: Array<{ el: Element; count: number }> = [];
	for (let i = 0; i < document.body.children.length; i++) {
		const child = document.body.children[i]!;
		if (SKIP_TAGS.has(child.tagName.toLowerCase())) continue;
		topSections.push({ el: child, count: child.querySelectorAll('*').length });
	}
	const totalElements = topSections.reduce((s, sec) => s + sec.count, 0);

	const sectionBudgets = new Map<Element, number>();
	for (const sec of topSections) {
		const proportion = totalElements > 0 ? sec.count / totalElements : 1 / topSections.length;
		sectionBudgets.set(sec.el, Math.max(10, Math.round(MAX_ELEMENTS * proportion)));
	}

	const sectionCounts = new Map<Element, number>();
	const findTopSection = (el: Element): Element | null => {
		let current: Element | null = el;
		while (current && current.parentElement !== document.body) current = current.parentElement;
		return current;
	};

	const walk = (parent: Element, depth: number): void => {
		if (depth > 6) return;

		for (let i = 0; i < parent.children.length; i++) {
			const el = parent.children[i]!;
			if (SKIP_TAGS.has(el.tagName.toLowerCase())) continue;
			if (isThirdParty(el)) continue;
			if (!isElementVisible(el)) continue;

			const topSection = findTopSection(el) || el;
			const currentCount = sectionCounts.get(topSection) || 0;
			const budget = sectionBudgets.get(topSection) || MAX_ELEMENTS;

			// Over budget: keep descending but sample only every third element.
			if (currentCount >= budget && currentCount % 3 !== 0) {
				sectionCounts.set(topSection, currentCount + 1);
				walk(el, depth + 1);
				continue;
			}

			if (elements.length >= MAX_ELEMENTS) return;
			sectionCounts.set(topSection, currentCount + 1);

			const { fingerprint, properties } = computeFingerprint(el);
			const walked: WalkedElement = {
				element: el,
				tag: el.tagName.toLowerCase(),
				role: classifyElement(el),
				fingerprint,
				properties,
				parent: parent === document.body ? null : parent,
				depth,
			};
			const pseudoColors = extractPseudoColors(el);
			if (pseudoColors.length > 0) walked.pseudoColors = pseudoColors;

			elements.push(walked);
			walk(el, depth + 1);
		}
	};

	walk(document.body, 0);
	return elements;
}

/** Colors painted by an element's ::before / ::after content (when it has content). */
function extractPseudoColors(el: Element): string[] {
	const colors: string[] = [];
	for (const pseudo of ['::before', '::after'] as const) {
		try {
			const style = window.getComputedStyle(el, pseudo);
			const content = style.content;
			if (!content || content === 'none' || content === '""' || content === "''" || content === '') continue;

			const bg = style.backgroundColor;
			if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
				const normalized = normalizeColor(bg);
				if (normalized) colors.push(normalized);
			}
			const color = style.color;
			if (color && color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') {
				const normalized = normalizeColor(color);
				if (normalized) colors.push(normalized);
			}
		} catch {
			// Cross-origin or unsupported pseudo; skip.
		}
	}
	return colors;
}

// ---------------------------------------------------------------------------
// Token collection
// ---------------------------------------------------------------------------

/** Collects the page's colors (paint props + pseudo-element colors), Oklab-clustered. */
function collectColors(walked: WalkedElement[]): ColorEntry[] {
	const colorMap = new Map<string, { contexts: Set<string>; count: number }>();
	const add = (value: string, context: string): void => {
		const existing = colorMap.get(value);
		if (existing) {
			existing.contexts.add(context);
			existing.count++;
		} else {
			colorMap.set(value, { contexts: new Set([context]), count: 1 });
		}
	};

	for (const el of walked) {
		const computed = window.getComputedStyle(el.element);
		for (const prop of COLOR_PROPS) {
			const value = computed.getPropertyValue(prop).trim();
			if (!value || value === 'rgba(0, 0, 0, 0)' || value === 'transparent') continue;
			const normalized = normalizeColor(value);
			if (normalized) add(normalized, prop);
		}
		for (const pc of el.pseudoColors ?? []) add(pc, 'pseudo');
	}

	const rawEntries = Array.from(colorMap.entries())
		.map(([value, data]) => ({ value, contexts: Array.from(data.contexts), count: data.count }))
		.sort((a, b) => b.count - a.count);

	return clusterColorsOklab(rawEntries).slice(0, 30);
}

/**
 * Clusters colors by Oklab perceptual distance (merge below 0.04), keeping the
 * most frequent member as the representative and a frequency-weighted centroid.
 * Non-hex colors (e.g. rgba with alpha) are kept as singleton clusters.
 */
function clusterColorsOklab(colors: ColorEntry[]): ColorEntry[] {
	if (colors.length <= 1) return colors;

	interface ColorCluster {
		representative: ColorEntry;
		lab: { L: number; a: number; b: number };
		totalCount: number;
		contexts: Set<string>;
		members: ColorEntry[];
	}
	const clusters: ColorCluster[] = [];
	const threshold = 0.04;

	for (const color of colors) {
		const rgb = hexToRgb(color.value);
		if (!rgb) {
			clusters.push({ representative: color, lab: { L: 0, a: 0, b: 0 }, totalCount: color.count, contexts: new Set(color.contexts), members: [color] });
			continue;
		}

		const lab = rgbToOklab(rgb.r, rgb.g, rgb.b);
		let merged = false;
		for (const cluster of clusters) {
			if (oklabDistance(lab, cluster.lab) >= threshold) continue;
			cluster.members.push(color);
			cluster.totalCount += color.count;
			color.contexts.forEach((c) => cluster.contexts.add(c));
			if (color.count > cluster.representative.count) cluster.representative = color;

			const totalWeight = cluster.members.reduce((s, m) => s + m.count, 0);
			let wL = 0, wA = 0, wB = 0;
			for (const m of cluster.members) {
				const mRgb = hexToRgb(m.value);
				if (!mRgb) continue;
				const mLab = rgbToOklab(mRgb.r, mRgb.g, mRgb.b);
				wL += mLab.L * m.count;
				wA += mLab.a * m.count;
				wB += mLab.b * m.count;
			}
			cluster.lab = { L: wL / totalWeight, a: wA / totalWeight, b: wB / totalWeight };
			merged = true;
			break;
		}
		if (!merged) clusters.push({ representative: color, lab, totalCount: color.count, contexts: new Set(color.contexts), members: [color] });
	}

	return clusters
		.map((c) => ({ value: c.representative.value, contexts: Array.from(c.contexts), count: c.totalCount }))
		.sort((a, b) => b.count - a.count);
}

/** Collects the font families used, with their sizes, weights, and inferred usage. */
function collectFonts(walked: WalkedElement[]): FontEntry[] {
	const fontMap = new Map<string, { sizes: Set<string>; weights: Set<number>; roles: Set<string> }>();
	for (const el of walked) {
		const computed = window.getComputedStyle(el.element);
		const family = computed.fontFamily.split(',')[0]!.trim().replace(/["']/g, '');
		const existing = fontMap.get(family);
		if (existing) {
			existing.sizes.add(computed.fontSize);
			existing.weights.add(parseInt(computed.fontWeight) || 400);
			existing.roles.add(el.role);
		} else {
			fontMap.set(family, { sizes: new Set([computed.fontSize]), weights: new Set([parseInt(computed.fontWeight) || 400]), roles: new Set([el.role]) });
		}
	}
	return Array.from(fontMap.entries()).map(([family, data]) => ({
		family,
		sizes: Array.from(data.sizes).sort((a, b) => parseFloat(a) - parseFloat(b)),
		weights: Array.from(data.weights).sort((a, b) => a - b),
		usage: inferFontUsage(data.roles),
	}));
}

/** Collects the distinct non-zero spacing values, sorted ascending (top 20). */
function collectSpacing(walked: WalkedElement[]): string[] {
	const spacingSet = new Set<string>();
	for (const el of walked) {
		const computed = window.getComputedStyle(el.element);
		for (const prop of SPACING_PROPS) {
			const value = computed.getPropertyValue(prop).trim();
			if (value && value !== '0px' && value !== 'normal' && value !== 'auto') spacingSet.add(value);
		}
	}
	return Array.from(spacingSet).sort((a, b) => parseFloat(a) - parseFloat(b)).slice(0, 20);
}

/** Collects distinct non-default values of one abbreviated fingerprint property. */
function collectValues(walked: WalkedElement[], propAbbr: string): string[] {
	const values = new Set<string>();
	for (const el of walked) {
		const val = el.properties[propAbbr];
		if (val && val !== '0px' && val !== 'none') values.add(val);
	}
	return Array.from(values).slice(0, 10);
}

/** Collects the distinct box-shadow values seen. */
function collectShadows(walked: WalkedElement[]): string[] {
	const shadows = new Set<string>();
	for (const el of walked) {
		const val = el.properties['bs'];
		if (val && val !== 'none') shadows.add(val);
	}
	return Array.from(shadows).slice(0, 8);
}

/** Detects the spacing base unit (4/5/6/8/10) and how much spacing sits on that grid. */
function analyzeSpacingBaseUnit(spacing: string[]): { baseUnit: number; gridCompliance: number; offGrid: string[] } | null {
	const pxValues = spacing.map((v) => parseFloat(v)).filter((v) => !isNaN(v) && v > 0);
	if (pxValues.length < 3) return null;

	let bestBase = 4;
	let bestScore = 0;
	for (const base of [4, 5, 6, 8, 10]) {
		const onGrid = pxValues.filter((v) => Math.abs(v % base) < 0.5).length;
		const score = onGrid / pxValues.length;
		if (score > bestScore) {
			bestScore = score;
			bestBase = base;
		}
	}

	const offGrid = spacing.filter((v) => {
		const px = parseFloat(v);
		return !isNaN(px) && px > 0 && Math.abs(px % bestBase) >= 0.5;
	});

	return { baseUnit: bestBase, gridCompliance: Math.round(bestScore * 100) / 100, offGrid: offGrid.slice(0, 10) };
}

/** Fits the page's font sizes to the closest modular type scale (null if no good fit). */
function detectTypographyScale(fonts: FontEntry[]): { ratio: number; name: string; base: number; deviation: number } | null {
	const allSizes = new Set<number>();
	for (const font of fonts) {
		for (const size of font.sizes) {
			const px = parseFloat(size);
			if (!isNaN(px) && px > 0) allSizes.add(px);
		}
	}

	const sizes = Array.from(allSizes).sort((a, b) => a - b);
	if (sizes.length < 3) return null;

	const bodySizes = sizes.filter((s) => s >= 12 && s <= 18);
	const base = bodySizes.length > 0 ? bodySizes[0]! : sizes[0]!;

	let bestRatio = 1.2;
	let bestName = 'Minor Third';
	let bestDeviation = Infinity;
	for (const { name, ratio } of MODULAR_SCALES) {
		const logRatio = Math.log(ratio);
		let totalDeviation = 0;
		let count = 0;
		for (const size of sizes) {
			if (size === base) continue;
			const logScale = Math.log(size / base) / logRatio;
			const nearestInt = Math.round(logScale);
			if (nearestInt === 0) continue;
			totalDeviation += Math.abs(logScale - nearestInt);
			count++;
		}
		const avgDeviation = count > 0 ? totalDeviation / count : Infinity;
		if (avgDeviation < bestDeviation) {
			bestDeviation = avgDeviation;
			bestRatio = ratio;
			bestName = name;
		}
	}

	if (bestDeviation > 0.3) return null;
	return { ratio: bestRatio, name: bestName, base, deviation: Math.round(bestDeviation * 1000) / 1000 };
}

/** Scores design consistency across the token sets and flags fragmentation issues. */
function analyzeConsistency(
	colors: ColorEntry[],
	radii: string[],
	shadows: string[],
	spacingAnalysis: { baseUnit: number; gridCompliance: number; offGrid: string[] } | null,
): { colors: number; spacing: number; radii: number; shadows: number; issues: string[] } {
	const issues: string[] = [];

	const colorScore = colors.length;
	if (colorScore > 15) issues.push(`High color count (${colorScore}) suggests inconsistent palette`);

	const spacingScore = spacingAnalysis ? spacingAnalysis.gridCompliance : 0;
	if (spacingScore < 0.6) issues.push(`Low grid compliance (${Math.round(spacingScore * 100)}%) - spacing is ad-hoc`);

	const radiiScore = radii.length;
	if (radiiScore > 5) issues.push(`Fragmented border-radii (${radiiScore} unique values)`);
	if (radiiScore >= 10) issues.push('CRITICAL: border-radius is highly inconsistent');

	const shadowScore = shadows.length;
	if (shadowScore > 5) issues.push(`Many shadow variants (${shadowScore}) - consider a shadow scale`);

	return { colors: colorScore, spacing: Math.round(spacingScore * 100), radii: radiiScore, shadows: shadowScore, issues };
}

// ---------------------------------------------------------------------------
// Pattern detection + deduplication
// ---------------------------------------------------------------------------

/**
 * Groups elements by role+fingerprint to find repeated component patterns (3+ of a
 * non-generic role), and produces a run-length-collapsed list where consecutive
 * identical elements carry a `repeat` count instead of repeating.
 */
function detectPatterns(walked: WalkedElement[]): { deduplicated: WalkedElement[]; components: ComponentPattern[] } {
	const groups = new Map<string, WalkedElement[]>();
	for (const el of walked) {
		const key = `${el.role}:${el.fingerprint}`;
		const group = groups.get(key) || [];
		group.push(el);
		groups.set(key, group);
	}

	const components: ComponentPattern[] = [];
	for (const group of groups.values()) {
		const rep = group[0]!;
		if (group.length >= 3 && rep.role !== 'generic' && rep.role !== 'text') {
			components.push({
				name: `${rep.role}-pattern`,
				role: rep.role,
				count: group.length,
				structure: { tag: rep.tag, role: rep.role },
				styleRefs: [],
			});
		}
	}

	const deduplicated: WalkedElement[] = [];
	let prevKey = '';
	let repeatCount = 0;
	for (const el of walked) {
		const key = `${el.role}:${el.fingerprint}`;
		if (key === prevKey && deduplicated.length > 0) {
			repeatCount++;
		} else {
			if (repeatCount > 0 && deduplicated.length > 0) deduplicated[deduplicated.length - 1]!.repeat = repeatCount + 1;
			deduplicated.push(el);
			repeatCount = 0;
		}
		prevKey = key;
	}
	if (repeatCount > 0 && deduplicated.length > 0) deduplicated[deduplicated.length - 1]!.repeat = repeatCount + 1;

	return { deduplicated, components };
}

// ---------------------------------------------------------------------------
// Interactive-state rules
// ---------------------------------------------------------------------------

/** Lifts hover/focus/active rules from the stylesheets that target walked elements. */
function extractStates(rules: CSSRule[], walked: WalkedElement[]): StateRule[] {
	const states: StateRule[] = [];
	const statePattern = /:(?:hover|focus|active|focus-visible)/;
	const walkedSelectors = new Set<string>();
	for (const el of walked) {
		for (const cls of Array.from(el.element.classList)) walkedSelectors.add(`.${cls}`);
	}

	for (const rule of rules) {
		if (!(rule instanceof CSSStyleRule)) continue;
		const selector = rule.selectorText;
		if (!statePattern.test(selector)) continue;

		const stateMatch = selector.match(/:(?:hover|focus|active|focus-visible)/);
		if (!stateMatch) continue;
		const state = stateMatch[0].slice(1) as StateRule['state'];

		const baseSelector = selector.replace(/:(?:hover|focus|active|focus-visible)/g, '').trim();
		let matches = false;
		for (const cls of walkedSelectors) {
			if (baseSelector.includes(cls)) {
				matches = true;
				break;
			}
		}
		if (!matches) continue;

		const changes: Record<string, string> = {};
		for (let i = 0; i < rule.style.length; i++) {
			const prop = rule.style[i]!;
			changes[prop] = rule.style.getPropertyValue(prop);
		}
		if (Object.keys(changes).length > 0) states.push({ selector, state, changes });
	}

	return states.slice(0, 30);
}

// ---------------------------------------------------------------------------
// Style map + structure tree
// ---------------------------------------------------------------------------

/** Builds the deduped style map (one entry per fingerprint) and the structure tree. */
function assemble(walked: WalkedElement[]): { styles: Record<string, Record<string, string>>; structure: SchemaNode[] } {
	const styleMap: Record<string, Record<string, string>> = {};
	const fingerprintToId = new Map<string, string>();
	let styleCounter = 0;

	for (const el of walked) {
		if (!el.fingerprint || fingerprintToId.has(el.fingerprint)) continue;
		if (Object.keys(el.properties).length === 0) continue;
		styleCounter++;
		const id = `s${styleCounter}`;
		fingerprintToId.set(el.fingerprint, id);
		styleMap[id] = el.properties;
	}

	const structure = buildTree(walked, fingerprintToId, 0, null, 4);
	return {
		styles: Object.fromEntries(Object.entries(styleMap).slice(0, 80)),
		structure: structure.slice(0, 50),
	};
}

/** Builds the nested structure tree of walked elements down to maxDepth. */
function buildTree(walked: WalkedElement[], fingerprintToId: Map<string, string>, depth: number, parent: Element | null, maxDepth: number): SchemaNode[] {
	if (depth >= maxDepth) return [];

	const nodes: SchemaNode[] = [];
	for (const el of walked.filter((e) => e.parent === parent)) {
		const node: SchemaNode = { tag: el.tag, role: el.role };
		const styleRef = fingerprintToId.get(el.fingerprint);
		if (styleRef) node.s = styleRef;
		const textPlaceholder = getTextPlaceholder(el);
		if (textPlaceholder) node.text = textPlaceholder;
		if (el.repeat && el.repeat > 1) node.repeat = el.repeat;
		const childNodes = buildTree(walked, fingerprintToId, depth + 1, el.element, maxDepth);
		if (childNodes.length > 0) node.children = childNodes;
		nodes.push(node);
	}
	return nodes;
}

// ---------------------------------------------------------------------------
// Section blueprints + content patterns
// ---------------------------------------------------------------------------

/** Detects the page's top-level sections and each section's composition. */
function extractSections(): SectionBlueprint[] {
	const candidates: Element[] = [];
	for (let i = 0; i < document.body.children.length; i++) {
		const el = document.body.children[i]!;
		if (SKIP_TAGS.has(el.tagName.toLowerCase())) continue;
		if (!isElementVisible(el)) continue;
		candidates.push(el);
	}
	const main = document.body.querySelector('main');
	if (main) {
		for (let i = 0; i < main.children.length; i++) {
			const el = main.children[i]!;
			if (SKIP_TAGS.has(el.tagName.toLowerCase())) continue;
			if (!isElementVisible(el)) continue;
			if (!candidates.includes(el)) candidates.push(el);
		}
	}

	const sections: SectionBlueprint[] = [];
	for (const el of candidates.slice(0, 20)) {
		const computed = window.getComputedStyle(el);
		const layout = detectLayoutPattern(el);
		const blueprint: SectionBlueprint = {
			type: classifySectionType(el),
			tag: el.tagName.toLowerCase(),
			layout,
			alignment: detectAlignment(computed),
			background: normalizeColor(computed.backgroundColor) || 'transparent',
			elements: catalogSectionElements(el),
		};

		if (layout.startsWith('grid-')) {
			const gridCols = computed.gridTemplateColumns;
			if (gridCols && gridCols !== 'none') blueprint.gridColumns = gridCols.split(/\s+/).filter((v) => v !== '').length;
		}

		if (computed.maxWidth && computed.maxWidth !== 'none') {
			blueprint.maxWidth = computed.maxWidth;
		} else {
			const firstChild = el.querySelector('[class*="container"], [class*="wrapper"], [class*="inner"]');
			if (firstChild) {
				const childMax = window.getComputedStyle(firstChild).maxWidth;
				if (childMax && childMax !== 'none') blueprint.maxWidth = childMax;
			}
		}

		if (computed.gap && computed.gap !== 'normal' && computed.gap !== '0px') blueprint.gap = computed.gap;
		const padding = `${computed.paddingTop} ${computed.paddingRight} ${computed.paddingBottom} ${computed.paddingLeft}`;
		if (padding !== '0px 0px 0px 0px') blueprint.padding = padding;

		sections.push(blueprint);
	}

	return sections;
}

/** Classifies a section into a semantic type by structure, then class/id, then content. */
function classifySectionType(el: Element): SectionType {
	const tag = el.tagName.toLowerCase();
	const text = (el.textContent || '').toLowerCase().slice(0, 500);
	const combined = `${classNameOf(el)} ${(el.id || '').toLowerCase()}`;

	if (tag === 'nav') return 'nav';
	if (tag === 'footer') return 'footer';

	const headings = el.querySelectorAll('h1, h2, h3');
	const buttons = el.querySelectorAll('button, a[class*="btn"], a[class*="button"]');
	const images = el.querySelectorAll('img');
	const cards = el.querySelectorAll('[class*="card"]');
	const paragraphs = el.querySelectorAll('p');

	const h1 = el.querySelector('h1');
	if (h1) {
		const h1Size = parseFloat(window.getComputedStyle(h1).fontSize || '0');
		if (h1Size >= 28 && paragraphs.length >= 1 && buttons.length >= 1) return 'hero';
	}

	if (cards.length >= 3) {
		const sampleCard = cards[0]!;
		if (sampleCard.querySelector('svg, img[src*="icon"], [class*="icon"]') && sampleCard.querySelector('h2, h3, h4') && sampleCard.querySelector('p')) return 'features';
	}

	if (cards.length >= 2) {
		const sampleCard = cards[0]!;
		const hasAvatar = sampleCard.querySelector('img[class*="avatar"], img[class*="photo"], img[src*="avatar"]');
		const hasQuote = sampleCard.querySelector('blockquote, p, [class*="quote"]');
		if ((hasAvatar || /[“”"]/.test(sampleCard.textContent || '')) && hasQuote) return 'testimonials';
	}

	if (cards.length >= 2) {
		const sampleCard = cards[0]!;
		const hasPriceIndicator = /\$|€|£|\/mo|\/yr|\/month|\/year|price/i.test(sampleCard.textContent || '');
		if (hasPriceIndicator && sampleCard.querySelector('ul, ol, [class*="feature"]') && sampleCard.querySelector('button, a[class*="btn"], a[class*="button"]')) return 'pricing';
	}

	const hasAccordion = el.querySelectorAll('details, [class*="accordion"], [data-accordion]').length > 0;
	const questionMarks = (text.match(/\?/g) || []).length;
	if (hasAccordion || (questionMarks >= 3 && headings.length >= 3)) return 'faq';

	const numberElements = el.querySelectorAll('[class*="stat"], [class*="number"], [class*="count"], [class*="metric"]');
	const bigNumbers = text.match(/\d{2,}[+%kKmMbB]?/g);
	if ((numberElements.length >= 3 || (bigNumbers && bigNumbers.length >= 3)) && cards.length <= 1) return 'stats';

	if (images.length >= 4 && headings.length <= 1) {
		const avgHeight = Array.from(images).slice(0, 8).reduce((s, img) => s + img.getBoundingClientRect().height, 0) / Math.min(images.length, 8);
		if (avgHeight < 80) return 'logos';
	}

	if (headings.length <= 2 && buttons.length >= 1 && cards.length === 0 && images.length <= 1) {
		if (el.getBoundingClientRect().height < 400 && /start|try|join|sign|get|download|ready|contact/i.test(text)) return 'cta';
	}

	if (/hero|banner|jumbotron|splash/.test(combined)) return 'hero';
	if (/feature|benefit|capability/.test(combined)) return 'features';
	if (/how[-_]?it[-_]?works|steps|process/.test(combined)) return 'how-it-works';
	if (/testimon|review|quote/.test(combined)) return 'testimonials';
	if (/pricing|plans?|tier/.test(combined)) return 'pricing';
	if (/faq|question|accordion/.test(combined)) return 'faq';
	if (/cta|call[-_]?to[-_]?action|get[-_]?started|sign[-_]?up/.test(combined)) return 'cta';
	if (/stats?|numbers|metrics|counter/.test(combined)) return 'stats';
	if (/logo|partner|client|brand|trusted/.test(combined)) return 'logos';
	if (/gallery|portfolio|showcase/.test(combined)) return 'gallery';

	if (tag === 'header' || el.querySelector('h1')) {
		if (el === el.parentElement?.querySelector('section, header')) return 'hero';
	}
	if (/[“”"]/.test(text.slice(0, 300)) && cards.length >= 2) return 'testimonials';
	if (el.querySelectorAll('[class*="star"], [class*="rating"]').length > 0) return 'testimonials';
	if (cards.length >= 3 || (headings.length >= 3 && images.length >= 2)) return 'features';
	if (buttons.length >= 1 && headings.length <= 2 && /start|try|join|sign|get|download/.test(text)) return 'cta';

	return 'content';
}

/** Reads a section's layout pattern from its (or its inner container's) flex/grid. */
function detectLayoutPattern(el: Element): LayoutPattern {
	const targets = [el];
	const inner = el.querySelector('[class*="container"], [class*="wrapper"], [class*="inner"], [class*="content"], [class*="grid"]');
	if (inner) targets.push(inner);

	for (const target of targets) {
		const computed = window.getComputedStyle(target);
		const display = computed.display;

		if (display === 'grid' || display === 'inline-grid') {
			const cols = computed.gridTemplateColumns;
			if (cols && cols !== 'none') {
				const colCount = cols.split(/\s+/).filter((v) => v && v !== '').length;
				if (colCount === 2) return 'grid-2';
				if (colCount === 3) return 'grid-3';
				if (colCount === 4) return 'grid-4';
				if (colCount > 4) return 'grid-n';
			}
		}

		if (display === 'flex' || display === 'inline-flex') {
			const direction = computed.flexDirection;
			if (direction === 'column' || direction === 'column-reverse') {
				if (computed.textAlign === 'center' || computed.alignItems === 'center') return 'centered-stack';
				return 'single-column';
			}
			if ((direction === 'row' || direction === 'row-reverse') && target.children.length === 2) {
				const first = target.children[0];
				const second = target.children[1];
				if (first && second) {
					const firstW = first.getBoundingClientRect().width;
					const secondW = second.getBoundingClientRect().width;
					const ratio = firstW / (firstW + secondW);
					if (ratio > 0.35 && ratio < 0.65) return direction === 'row-reverse' ? 'two-column-reverse' : 'two-column';
					return 'split';
				}
			}
		}
	}

	if (window.getComputedStyle(el).textAlign === 'center') return 'centered-stack';
	return 'single-column';
}

/** Reads a section's alignment from text-align / align-items. */
function detectAlignment(computed: CSSStyleDeclaration): 'left' | 'center' | 'right' {
	if (computed.textAlign === 'center' || computed.alignItems === 'center') return 'center';
	if (computed.textAlign === 'right' || computed.alignItems === 'flex-end') return 'right';
	return 'left';
}

/** Catalogs the ordered, deduplicated semantic elements present in a section. */
function catalogSectionElements(section: Element): string[] {
	const elements: string[] = [];
	const seen = new Set<string>();
	const addOnce = (name: string): void => {
		if (!seen.has(name)) {
			elements.push(name);
			seen.add(name);
		}
	};

	const walk = (el: Element, depth: number): void => {
		if (depth > 4) return;
		const tag = el.tagName.toLowerCase();
		const classList = classNameOf(el);

		if (/^h[1-6]$/.test(tag)) {
			addOnce(parseFloat(window.getComputedStyle(el).fontSize) >= 32 ? 'heading' : 'subheading');
		} else if (tag === 'p') {
			addOnce('text');
		} else if (tag === 'img' || tag === 'picture' || tag === 'video') {
			addOnce('image');
		} else if (tag === 'button' || (tag === 'a' && isButtonLike(el))) {
			addOnce('button');
			const siblings = el.parentElement?.querySelectorAll('button, a[class*="btn"], a[class*="button"]');
			if (siblings && siblings.length >= 2 && !seen.has('button-pair')) {
				elements.pop(); // Replace the lone 'button' with 'button-pair'.
				seen.delete('button');
				addOnce('button-pair');
			}
		} else if (tag === 'form' || tag === 'input') {
			addOnce('form');
		} else if (tag === 'nav') {
			addOnce('nav-links');
		} else if (tag === 'ul' || tag === 'ol') {
			addOnce('list');
		}

		if (/badge|chip|pill|tag/.test(classList)) addOnce('badge');
		if (/card/.test(classList) && !seen.has('card-grid')) {
			const siblingCards = el.parentElement?.querySelectorAll('[class*="card"]');
			if (siblingCards && siblingCards.length >= 2) addOnce('card-grid');
		}
		if (tag === 'svg' || /icon/.test(classList)) addOnce('icon');

		for (let i = 0; i < el.children.length; i++) walk(el.children[i]!, depth + 1);
	};

	walk(section, 0);
	return elements.slice(0, 12);
}

/** Counts recurring element groupings (e.g. "heading+text+button-pair") across sections. */
function extractContentPatterns(sections: SectionBlueprint[]): ContentGrouping[] {
	const patternCounts = new Map<string, { count: number; elements: string[] }>();
	for (const section of sections) {
		for (const p of findSubPatterns(section.elements)) {
			const key = p.join('+');
			const existing = patternCounts.get(key);
			if (existing) existing.count++;
			else patternCounts.set(key, { count: 1, elements: p });
		}
	}
	return Array.from(patternCounts.entries())
		.map(([pattern, data]) => ({ pattern, occurrences: data.count, elements: data.elements }))
		.filter((p) => p.occurrences >= 1)
		.sort((a, b) => b.occurrences - a.occurrences)
		.slice(0, 10);
}

/** Finds the meaningful sub-patterns within a section's element list. */
function findSubPatterns(elements: string[]): string[][] {
	const patterns: string[][] = [];
	const hasHeading = elements.includes('heading') || elements.includes('subheading');
	const hasText = elements.includes('text');
	const hasButton = elements.includes('button') || elements.includes('button-pair');
	const buttonName = elements.includes('button-pair') ? 'button-pair' : 'button';

	if (hasHeading && hasText && hasButton) patterns.push(['heading', 'text', buttonName]);
	else if (hasHeading && hasText) patterns.push(['heading', 'text']);
	else if (hasHeading && hasButton) patterns.push(['heading', buttonName]);

	if (elements.includes('badge') && hasHeading) patterns.push(['badge', 'heading']);
	if (elements.includes('icon') && hasHeading && hasText) patterns.push(['icon', 'heading', 'text']);
	if (elements.includes('image') && hasHeading) patterns.push(['image', 'heading', 'text']);

	return patterns;
}

// ---------------------------------------------------------------------------
// Component blueprints
// ---------------------------------------------------------------------------

/** Extracts the top button variants with their full visual spec and hover/active states. */
function extractButtonBlueprints(walked: WalkedElement[], states: StateRule[]): ButtonBlueprint[] {
	const buttons = walked.filter((el) => el.role === 'button');
	if (buttons.length === 0) return [];

	const groups = new Map<string, WalkedElement[]>();
	for (const btn of buttons) {
		const group = groups.get(btn.fingerprint) || [];
		group.push(btn);
		groups.set(btn.fingerprint, group);
	}
	const sorted = Array.from(groups.entries()).sort((a, b) => b[1].length - a[1].length).slice(0, 4);

	const pageBg = normalizeColor(window.getComputedStyle(document.body).backgroundColor) || '#ffffff';
	const blueprints: ButtonBlueprint[] = [];

	for (let i = 0; i < sorted.length; i++) {
		const rep = sorted[i]![1][0]!;
		const computed = window.getComputedStyle(rep.element);
		const bg = normalizeColor(computed.backgroundColor) || 'transparent';
		const color = normalizeColor(computed.color) || '#000000';
		const shadow = computed.boxShadow !== 'none' ? computed.boxShadow : '';
		const border = computed.borderWidth !== '0px' && computed.borderStyle !== 'none' ? `${computed.borderWidth} ${computed.borderStyle} ${computed.borderColor}` : 'none';

		const btnClasses = Array.from(rep.element.classList);
		const hover: Record<string, string> = {};
		const active: Record<string, string> = {};
		for (const state of states) {
			if (!btnClasses.some((cls) => state.selector.includes(`.${cls}`))) continue;
			if (state.state === 'hover') Object.assign(hover, state.changes);
			if (state.state === 'active') Object.assign(active, state.changes);
		}

		let styleTag = 'flat';
		if (shadow.includes('0px 4px 0') || shadow.includes('0 4px 0') || shadow.includes('0px 3px 0')) {
			styleTag = 'pressed-3d';
		} else if (computed.backgroundImage && computed.backgroundImage !== 'none' && computed.backgroundImage.includes('gradient')) {
			styleTag = 'gradient';
		} else if (bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)') {
			styleTag = border !== 'none' ? 'outline' : 'ghost';
		} else if (shadow && shadow !== 'none') {
			styleTag = 'elevated';
		}

		const isTransparent = bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)';
		const isWhiteOrLight = bg === '#ffffff' || bg === '#fff' || bg === pageBg;
		let variant: string;
		if (isTransparent && border === 'none') variant = 'ghost';
		else if (isTransparent) variant = 'outline';
		else if (i === 0) variant = 'primary';
		else if (isWhiteOrLight) variant = 'secondary';
		else variant = 'accent';

		blueprints.push({
			variant,
			bg,
			color,
			borderRadius: computed.borderRadius,
			padding: `${computed.paddingTop} ${computed.paddingRight} ${computed.paddingBottom} ${computed.paddingLeft}`,
			fontWeight: parseInt(computed.fontWeight) || 400,
			fontSize: computed.fontSize,
			border,
			shadow,
			hover,
			active,
			styleTag,
		});
	}

	// Propagate the dominant non-flat style language to filled variants whose shadow
	// the extraction missed (a capture gap reads as flat, not as intentional flatness).
	const tagCounts = new Map<string, number>();
	for (const bp of blueprints) tagCounts.set(bp.styleTag, (tagCounts.get(bp.styleTag) || 0) + 1);
	const dominantTag = Array.from(tagCounts.entries()).filter(([tag]) => tag !== 'flat').sort((a, b) => b[1] - a[1])[0];
	if (dominantTag && dominantTag[1] >= 2) {
		for (const bp of blueprints) {
			const isFilled = bp.bg !== 'transparent' && bp.bg !== 'rgba(0, 0, 0, 0)';
			if (isFilled && bp.styleTag === 'flat' && (!bp.shadow || bp.shadow === 'none')) bp.styleTag = dominantTag[0];
		}
	}

	// Disambiguate any variant names that collided.
	const seen = new Set<string>();
	for (const bp of blueprints) {
		if (seen.has(bp.variant)) bp.variant = `${bp.variant}-${seen.size}`;
		seen.add(bp.variant);
	}

	return blueprints;
}

/** Extracts the top card variants with their visual spec, hover state, and inner layout. */
function extractCardBlueprints(walked: WalkedElement[], states: StateRule[]): CardBlueprint[] {
	const cards = walked.filter((el) => el.role === 'card');
	if (cards.length === 0) return [];

	const groups = new Map<string, WalkedElement[]>();
	for (const card of cards) {
		const group = groups.get(card.fingerprint) || [];
		group.push(card);
		groups.set(card.fingerprint, group);
	}
	const sorted = Array.from(groups.entries()).sort((a, b) => b[1].length - a[1].length).slice(0, 3);

	const blueprints: CardBlueprint[] = [];
	for (const [, group] of sorted) {
		const rep = group[0]!;
		const computed = window.getComputedStyle(rep.element);
		const cardClasses = Array.from(rep.element.classList);
		const hover: Record<string, string> = {};
		for (const state of states) {
			if (state.state === 'hover' && cardClasses.some((cls) => state.selector.includes(`.${cls}`))) Object.assign(hover, state.changes);
		}

		blueprints.push({
			bg: normalizeColor(computed.backgroundColor) || '#ffffff',
			borderRadius: computed.borderRadius,
			shadow: computed.boxShadow !== 'none' ? computed.boxShadow : 'none',
			border: computed.borderWidth !== '0px' && computed.borderStyle !== 'none' ? `${computed.borderWidth} ${computed.borderStyle} ${computed.borderColor}` : 'none',
			padding: `${computed.paddingTop} ${computed.paddingRight} ${computed.paddingBottom} ${computed.paddingLeft}`,
			hover,
			innerLayout: detectCardInnerLayout(rep.element),
		});
	}

	return blueprints;
}

/** Describes a card's inner layout as an ordered "image + heading + text" string. */
function detectCardInnerLayout(el: Element): string {
	const parts: string[] = [];
	for (let i = 0; i < Math.min(el.children.length, 6); i++) {
		const child = el.children[i]!;
		const tag = child.tagName.toLowerCase();
		const classList = classNameOf(child);
		if (tag === 'img' || tag === 'picture' || tag === 'video' || /image|thumbnail|cover/.test(classList)) parts.push('image');
		else if (/^h[1-6]$/.test(tag)) parts.push('heading');
		else if (tag === 'p') parts.push('text');
		else if (tag === 'svg' || /icon/.test(classList)) parts.push('icon');
		else if (tag === 'button' || /btn|button/.test(classList)) parts.push('button');
		else if (child.children.length > 0) parts.push('body');
	}
	return parts.length > 0 ? parts.join(' + ') : 'unknown';
}

/** Extracts the page navigation's spec (bg, position, blur, border, layout, link count). */
function extractNavBlueprint(): NavBlueprint | null {
	const nav = document.querySelector('nav') || document.querySelector('header nav') || document.querySelector('[role="navigation"]');
	if (!nav) return null;

	const computed = window.getComputedStyle(nav);
	const links = nav.querySelectorAll('a');
	const border = computed.borderBottomWidth !== '0px' && computed.borderBottomStyle !== 'none' ? `${computed.borderBottomWidth} ${computed.borderBottomStyle} ${computed.borderBottomColor}` : 'none';

	let layout = 'unknown';
	if (nav.children.length >= 2) {
		const hasLogo = nav.querySelector('[class*="logo"], a:first-child img, a:first-child svg');
		const hasCta = nav.querySelector('[class*="cta"], [class*="btn"], button');
		const hasLinks = links.length >= 3;
		if (hasLogo && hasLinks && hasCta) layout = 'logo-left + links-center + cta-right';
		else if (hasLogo && hasLinks) layout = 'logo-left + links-right';
		else if (hasLogo && hasCta) layout = 'logo-left + cta-right';
		else if (hasLogo) layout = 'logo-left';
	}

	return {
		bg: normalizeColor(computed.backgroundColor) || 'transparent',
		position: computed.position,
		height: computed.height,
		blur: computed.backdropFilter !== 'none' || (computed as CSSStyleDeclaration & { webkitBackdropFilter?: string }).webkitBackdropFilter !== 'none',
		border,
		layout,
		linkCount: links.length,
	};
}

/** Detects the page's decorative language: blobs, gradients, illustration style, accents. */
function extractDecorativeInfo(): DecorativeInfo {
	let hasBlobs = false;
	let hasGradientBgs = false;
	let hasPatterns = false;
	const backgroundEffects = new Set<string>();
	const accentTreatments = new Set<string>();

	const allElements = document.querySelectorAll('*');
	const sampleSize = Math.min(allElements.length, 200);
	for (let i = 0; i < sampleSize; i++) {
		const el = allElements[Math.floor((i * allElements.length) / sampleSize)]!;
		const computed = window.getComputedStyle(el);

		if (computed.backgroundImage && computed.backgroundImage.includes('gradient')) {
			hasGradientBgs = true;
			backgroundEffects.add('gradient');
		}
		if (computed.backdropFilter && computed.backdropFilter !== 'none') backgroundEffects.add('backdrop-blur');
		if (computed.filter && computed.filter.includes('blur') && parseFloat(computed.filter.replace(/[^0-9.]/g, '')) > 20) {
			hasBlobs = true;
			backgroundEffects.add('blur-blobs');
		}
		if (computed.borderRadius === '50%' || computed.borderRadius === '9999px') {
			if (el.getBoundingClientRect().width > 80) hasBlobs = true;
		}
		if (computed.backgroundImage && (computed.backgroundImage.includes('repeating') || computed.backgroundImage.includes('url('))) hasPatterns = true;
	}

	let svgImgCount = 0;
	let rasterCount = 0;
	for (const img of Array.from(document.querySelectorAll('img')).slice(0, 30)) {
		const src = (img.getAttribute('src') || '').toLowerCase();
		if (src.includes('.svg') || src.startsWith('data:image/svg')) svgImgCount++;
		else if (src.includes('.jpg') || src.includes('.jpeg') || src.includes('.png') || src.includes('.webp') || src.includes('.avif')) rasterCount++;
	}
	let significantSvgCount = 0;
	for (const svg of Array.from(document.querySelectorAll('svg')).slice(0, 30)) {
		const rect = svg.getBoundingClientRect();
		if (rect.width > 40 && rect.height > 40) significantSvgCount++;
	}

	const totalSvgs = svgImgCount + significantSvgCount;
	const totalMedia = totalSvgs + rasterCount;
	const svgRatio = totalMedia > 0 ? Math.round((totalSvgs / totalMedia) * 100) / 100 : 0;
	const photoRatio = totalMedia > 0 ? Math.round((rasterCount / totalMedia) * 100) / 100 : 0;

	let illustrationStyle = 'none';
	if (totalMedia === 0) illustrationStyle = 'none';
	else if (svgRatio > 0.6 && totalSvgs >= 3) illustrationStyle = 'icon-based';
	else if (photoRatio > 0.6 && rasterCount >= 3) illustrationStyle = 'photo';
	else if (totalMedia >= 3) illustrationStyle = 'mixed';

	for (const btn of Array.from(document.querySelectorAll('button, [class*="btn"]')).slice(0, 10)) {
		const computed = window.getComputedStyle(btn);
		if (computed.boxShadow.includes('0px 4px 0') || computed.boxShadow.includes('0 4px 0')) accentTreatments.add('hard-shadow-buttons');
		if (computed.backgroundImage?.includes('gradient')) accentTreatments.add('gradient-buttons');
	}
	if (document.querySelectorAll('[class*="badge"], [class*="pill"], [class*="chip"], [class*="tag"]').length >= 2) accentTreatments.add('pill-badges');

	return { hasBlobs, hasGradientBgs, hasPatterns, illustrationStyle, svgRatio, photoRatio, backgroundEffects: Array.from(backgroundEffects), accentTreatments: Array.from(accentTreatments) };
}

/** Reads the page's responsive behavior from its media queries. */
function extractResponsiveInfo(rules: CSSRule[]): ResponsiveInfo {
	const breakpoints = new Set<string>();
	let mobileNavStyle = 'unchanged';
	let gridCollapseBehavior = 'stack';

	for (const rule of rules) {
		if (!(rule instanceof CSSMediaRule)) continue;
		const media = rule.conditionText || rule.media?.mediaText || '';
		const widthMatch = media.match(/(?:max|min)-width:\s*(\d+(?:\.\d+)?(?:px|em|rem))/);
		if (widthMatch) breakpoints.add(widthMatch[1]!);

		const ruleText = Array.from(rule.cssRules || []).map((r) => (r instanceof CSSStyleRule ? r.cssText : '')).join(' ');
		if (/nav.*display:\s*none|\.nav-links.*display:\s*none|\.menu.*display:\s*none/.test(ruleText)) mobileNavStyle = 'hamburger';
		if (/grid-template-columns:\s*1fr\b/.test(ruleText)) gridCollapseBehavior = 'stack';
		else if (/overflow-x:\s*(?:auto|scroll)/.test(ruleText)) gridCollapseBehavior = 'scroll';
		else if (/grid-template-columns:\s*repeat\(2/.test(ruleText)) gridCollapseBehavior = 'reduce-columns';
	}

	return { breakpoints: Array.from(breakpoints).sort((a, b) => parseFloat(a) - parseFloat(b)).slice(0, 5), mobileNavStyle, gridCollapseBehavior };
}

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

/** A text placeholder token for an element's role (e.g. "{h1}", "{btn}", "{img 200x80}"). */
function getTextPlaceholder(el: WalkedElement): string | undefined {
	switch (el.role) {
		case 'heading': return `{${el.tag}}`;
		case 'paragraph': return '{p}';
		case 'button': return '{btn}';
		case 'link': return '{link}';
		case 'input': return '{input}';
		case 'image': {
			const rect = el.element.getBoundingClientRect();
			return `{img ${Math.round(rect.width)}x${Math.round(rect.height)}}`;
		}
		default: return undefined;
	}
}

/** Infers a font's role (heading / body / ui / mixed) from the roles it appears in. */
function inferFontUsage(roles: Set<string>): string {
	if (roles.has('heading')) return 'heading';
	if (roles.has('paragraph') || roles.has('text')) return 'body';
	if (roles.has('button') || roles.has('input')) return 'ui';
	return 'mixed';
}

/** Normalizes a paint value to hex when opaque, keeps rgba when translucent, null if absent. */
function normalizeColor(value: string): string | null {
	if (value === 'transparent' || value === 'rgba(0, 0, 0, 0)') return null;
	const rgbMatch = value.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/);
	if (rgbMatch) {
		const [, r, g, b, a] = rgbMatch;
		if (a !== undefined && parseFloat(a) < 1) return value;
		return '#' + [r, g, b].map((c) => parseInt(c!).toString(16).padStart(2, '0')).join('');
	}
	return value;
}

/** True when an anchor is styled like a button (btn/button/cta in its class list). */
function isButtonLike(el: Element): boolean {
	return /btn|button|cta/.test(classNameOf(el));
}

/** Parse a #rrggbb hex string to rgb. */
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
	const m = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
	if (!m) return null;
	return { r: parseInt(m[1]!, 16), g: parseInt(m[2]!, 16), b: parseInt(m[3]!, 16) };
}

/** sRGB channel [0-255] to linear-light [0-1]. */
function srgbToLinear(c: number): number {
	const s = c / 255;
	return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** RGB to Oklab (the perceptually uniform model color clustering measures distance in). */
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
