/**
 * inspect/schema/fingerprint.ts: compact style fingerprints + abbreviations
 *
 * Pipeline position: inspect, page-scoped. It reads the live dom directly and does not run the element pipeline.
 * Reads from DOM: document/window. This runs live, on per-element computed styles.
 * Writes to: nothing. This is pure computation.
 *
 * Principles applied: none. This is computation.
 *
 * Why this exists: the schema collapses elements that look identical into a single
 * style-map entry. A fingerprint is the sorted, abbreviated list of an element's
 * non-default design properties, so two elements with the same fingerprint share a
 * style. The abbreviations keep the style map compact, and they must match the
 * abbreviation legend in inspect/prompts.ts so the ai pass can decode them. Ported
 * by rewriting from v1 schema/style-fingerprint.ts.
 */

/** The design-relevant properties a fingerprint is built from. */
const FINGERPRINT_PROPS = [
	'display', 'position', 'color', 'background-color',
	'font-size', 'font-weight', 'font-family', 'line-height',
	'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
	'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
	'gap', 'flex-direction', 'justify-content', 'align-items',
	'border-radius', 'box-shadow', 'opacity', 'text-align',
	'text-decoration', 'text-transform', 'letter-spacing',
	'border-width', 'border-style', 'border-color',
	'max-width', 'overflow', 'cursor',
] as const;

/** Values left out of the fingerprint because they carry no design signal. */
const DEFAULT_VALUES: Record<string, Set<string>> = {
	'display': new Set(['block', 'inline']),
	'position': new Set(['static']),
	'color': new Set([]),
	'background-color': new Set(['rgba(0, 0, 0, 0)', 'transparent']),
	'font-size': new Set([]),
	'font-weight': new Set(['400', 'normal']),
	'font-family': new Set([]),
	'line-height': new Set(['normal']),
	'padding-top': new Set(['0px']),
	'padding-right': new Set(['0px']),
	'padding-bottom': new Set(['0px']),
	'padding-left': new Set(['0px']),
	'margin-top': new Set(['0px']),
	'margin-right': new Set(['0px']),
	'margin-bottom': new Set(['0px']),
	'margin-left': new Set(['0px']),
	'gap': new Set(['normal', '0px']),
	'flex-direction': new Set(['row']),
	'justify-content': new Set(['normal', 'flex-start']),
	'align-items': new Set(['normal', 'stretch']),
	'border-radius': new Set(['0px']),
	'box-shadow': new Set(['none']),
	'opacity': new Set(['1']),
	'text-align': new Set(['start']),
	'text-decoration': new Set(['none', 'none solid rgb(0, 0, 0)']),
	'text-transform': new Set(['none']),
	'letter-spacing': new Set(['normal']),
	'border-width': new Set(['0px']),
	'border-style': new Set(['none']),
	'border-color': new Set(['currentcolor']),
	'max-width': new Set(['none']),
	'overflow': new Set(['visible']),
	'cursor': new Set(['auto']),
};

/** Property-name abbreviations for compact style-map entries. The legend is mirrored in the prompt. */
export const PROP_ABBREVIATIONS: Record<string, string> = {
	'display': 'd', 'position': 'p', 'width': 'w', 'height': 'h',
	'max-width': 'mw', 'max-height': 'mh',
	'margin-top': 'mt', 'margin-right': 'mr', 'margin-bottom': 'mb', 'margin-left': 'ml',
	'padding-top': 'pt', 'padding-right': 'pr', 'padding-bottom': 'pb', 'padding-left': 'pl',
	'background-color': 'bg', 'color': 'c', 'font-size': 'fs', 'font-weight': 'fw',
	'font-family': 'ff', 'line-height': 'lh', 'text-align': 'ta',
	'text-decoration': 'td', 'text-transform': 'tt', 'letter-spacing': 'ls',
	'white-space': 'ws', 'border-radius': 'br', 'box-shadow': 'bs',
	'border': 'b', 'opacity': 'o', 'overflow': 'of', 'gap': 'g',
	'flex-direction': 'fd', 'flex-wrap': 'fwrap',
	'justify-content': 'jc', 'align-items': 'ai', 'align-content': 'ac',
	'flex-grow': 'fg', 'flex-shrink': 'fsh', 'flex-basis': 'fb',
	'grid-template-columns': 'gtc', 'grid-template-rows': 'gtr',
	'transition': 't', 'transform': 'tr', 'z-index': 'z',
	'cursor': 'cur', 'pointer-events': 'pe', 'visibility': 'v',
	'background-image': 'bgi', 'background-size': 'bgs', 'background-position': 'bgp',
	'border-width': 'bw', 'border-style': 'bst', 'border-color': 'bc',
};

/** A fingerprint string plus the abbreviated non-default properties it was built from. */
export interface FingerprintResult {
	fingerprint: string;
	properties: Record<string, string>;
}

/**
 * Computes an element's style fingerprint: the sorted, abbreviated list of its
 * non-default design properties. The same fingerprint means the same style.
 */
export function computeFingerprint(element: Element): FingerprintResult {
	const computed = window.getComputedStyle(element);
	const properties: Record<string, string> = {};
	const parts: string[] = [];

	for (const prop of FINGERPRINT_PROPS) {
		const value = computed.getPropertyValue(prop).trim();
		if (!value) continue;
		if (DEFAULT_VALUES[prop]?.has(value)) continue;

		const abbr = PROP_ABBREVIATIONS[prop] || prop;
		properties[abbr] = value;
		parts.push(`${abbr}:${value}`);
	}

	parts.sort();
	return { fingerprint: parts.join('|'), properties };
}
