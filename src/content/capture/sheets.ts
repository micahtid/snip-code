/**
 * capture/sheets.ts — stylesheet discovery (cssom)
 *
 * Phase: b (capture) — see SNIPCODE-REWRITE-PLAN.md section 12
 * Pipeline position: 1 — capture
 * Reads from Captured: n/a (reads the live document.styleSheets)
 * Writes to Captured: stylesheets, foundationRules, componentRules, variables,
 *   fonts, keyframes, inaccessible.crossOriginStylesheets
 *
 * Principles applied: none directly (capture-time discovery feeds P1-P3 later).
 *
 * Why this exists: a snipped element's appearance comes from rules scattered
 * across every sheet on the page — <style> blocks, linked css, injected sheets.
 * this module flattens all of them into a single CssRule[] (section 19.1),
 * preserving each rule's grouping context (@media/@container/@layer/@supports) so
 * later phases can decide what survives serialization. it splits broadly-scoped
 * "foundation" rules (html/body/:root/*) from element-scoped "component" rules;
 * reconcile/match.ts (commit 6) refines the component set by actually matching
 * against captured elements. cross-origin sheets that throw on .cssRules are
 * recorded as inaccessible here and recovered via cdp/background fetch in commit
 * 4. shadow + adoptedStyleSheets discovery lands with the shadow handler.
 */
import type { CssRule, CssVariable, FontFace, Keyframes, Stylesheet } from '../types';

/** everything sheets discovery contributes to Captured, returned for the orchestrator to assign. */
export interface SheetDiscovery {
	stylesheets: Stylesheet[];
	foundationRules: CssRule[];
	componentRules: CssRule[];
	variables: CssVariable[];
	fonts: FontFace[];
	keyframes: Keyframes[];
	crossOriginStylesheets: string[];
}

/** grouping context threaded down through nested @media/@supports/@layer/@container. */
interface RuleContext {
	mediaQuery?: string;
	supports?: string;
	layer?: string;
	containerQuery?: string;
}

/**
 * walks every accessible stylesheet in the document and flattens it.
 *
 * cross-origin sheets raise a SecurityError when their .cssRules is read; we
 * catch that and record the href for later background fetch rather than failing.
 *
 * @returns the discovered rules, variables, fonts, keyframes, and sheet metadata
 */
export function discoverStylesheets(): SheetDiscovery {
	const out: SheetDiscovery = {
		stylesheets: [],
		foundationRules: [],
		componentRules: [],
		variables: [],
		fonts: [],
		keyframes: [],
		crossOriginStylesheets: [],
	};

	for (const sheet of Array.from(document.styleSheets)) {
		const origin = sheetOrigin(sheet);
		let rules: CSSRuleList | null = null;
		try {
			rules = sheet.cssRules; // throws SecurityError on cross-origin
		} catch {
			// cannot read this sheet from the content script; remember its href so
			// commit 4 can re-fetch it through the privileged background worker.
			if (sheet.href) out.crossOriginStylesheets.push(sheet.href);
			out.stylesheets.push({ href: sheet.href, origin: 'cross-origin', ruleCount: 0 });
			continue;
		}
		const before = out.foundationRules.length + out.componentRules.length;
		walkRules(rules, {}, out, 'cssom');
		const after = out.foundationRules.length + out.componentRules.length;
		out.stylesheets.push({ href: sheet.href, origin, ruleCount: after - before });
	}

	return out;
}

/**
 * parses a raw css string into the same discovery shape, for cross-origin sheets
 * recovered through the background worker (commit 4, capture/cdp.ts).
 *
 * uses a constructable stylesheet so parsing never touches the live page. the
 * resulting rules carry the caller's `source` tag so downstream phases can tell
 * recovered rules from cssom-read ones.
 *
 * @param cssText — the stylesheet text fetched by the background
 * @param source — provenance tag for the produced CssRule entries
 * @returns the discovery deltas (rules, variables, fonts, keyframes)
 */
export async function parseCssText(cssText: string, source: CssRule['source'] = 'cssom'): Promise<SheetDiscovery> {
	const out: SheetDiscovery = {
		stylesheets: [],
		foundationRules: [],
		componentRules: [],
		variables: [],
		fonts: [],
		keyframes: [],
		crossOriginStylesheets: [],
	};
	const sheet = new CSSStyleSheet();
	await sheet.replace(cssText);
	walkRules(sheet.cssRules, {}, out, source);
	return out;
}

/** classify a sheet's origin from its owner node and href. */
function sheetOrigin(sheet: CSSStyleSheet): Stylesheet['origin'] {
	if (sheet.ownerNode instanceof HTMLStyleElement) return 'inline';
	if (!sheet.href) return 'inline';
	try {
		return new URL(sheet.href, location.href).origin === location.origin ? 'same-origin' : 'cross-origin';
	} catch {
		return 'same-origin';
	}
}

/**
 * recursively flattens a rule list, threading grouping context down into nested
 * blocks. style rules become CssRule entries; @font-face and @keyframes are
 * lifted into their own collections; custom properties are harvested as
 * CssVariable definitions.
 */
function walkRules(rules: CSSRuleList, ctx: RuleContext, out: SheetDiscovery, source: CssRule['source']): void {
	for (const rule of Array.from(rules)) {
		if (rule instanceof CSSStyleRule) {
			collectStyleRule(rule, ctx, out, source);
		} else if (rule instanceof CSSMediaRule) {
			walkRules(rule.cssRules, { ...ctx, mediaQuery: rule.conditionText }, out, source);
		} else if (rule instanceof CSSSupportsRule) {
			walkRules(rule.cssRules, { ...ctx, supports: rule.conditionText }, out, source);
		} else if (rule instanceof CSSFontFaceRule) {
			collectFontFace(rule, out);
		} else if (rule instanceof CSSKeyframesRule) {
			out.keyframes.push({
				name: rule.name,
				rules: Array.from(rule.cssRules)
					.map((r) => r.cssText)
					.join('\n'),
			});
		} else if (isGroupingRule(rule)) {
			// @layer { ... } and @container ... { ... }. these are recent rule
			// types not always present in the dom lib; detect structurally and read
			// their identifying field defensively (the layers/units handlers refine
			// this later — here we just preserve the context).
			const layer = readField(rule, 'name');
			const containerQuery = readField(rule, 'conditionText');
			walkRules(rule.cssRules, {
				...ctx,
				...(layer ? { layer } : {}),
				...(containerQuery ? { containerQuery } : {}),
			}, out, source);
		}
		// CSSImportRule and others are ignored here; @import resolution for
		// cross-origin sheets is handled at fetch time (commit 4).
	}
}

/** turn a CSSStyleRule into a CssRule, harvesting any custom-property defs. */
function collectStyleRule(rule: CSSStyleRule, ctx: RuleContext, out: SheetDiscovery, source: CssRule['source']): void {
	const properties = new Map<string, string>();
	const style = rule.style;
	for (let i = 0; i < style.length; i++) {
		const prop = style.item(i);
		if (!prop) continue;
		const value = style.getPropertyValue(prop).trim();
		properties.set(prop, value);
		if (prop.startsWith('--')) {
			out.variables.push({
				name: prop,
				value,
				resolved: false, // P3 resolves later (resolve/vars.ts)
				scope: isRootScope(rule.selectorText) ? 'root' : 'element',
			});
		}
	}
	const entry: CssRule = {
		selector: rule.selectorText,
		properties,
		specificity: specificityOf(rule.selectorText),
		source,
		...(ctx.mediaQuery ? { mediaQuery: ctx.mediaQuery } : {}),
		...(ctx.containerQuery ? { containerQuery: ctx.containerQuery } : {}),
		...(ctx.layer ? { layer: ctx.layer } : {}),
		...(ctx.supports ? { supports: ctx.supports } : {}),
	};
	if (isFoundationSelector(rule.selectorText)) out.foundationRules.push(entry);
	else out.componentRules.push(entry);
}

/** lift an @font-face into a FontFace record with all descriptors. */
function collectFontFace(rule: CSSFontFaceRule, out: SheetDiscovery): void {
	const style = rule.style;
	const descriptors: Record<string, string> = {};
	let family = '';
	let src = '';
	for (let i = 0; i < style.length; i++) {
		const prop = style.item(i);
		if (!prop) continue;
		const value = style.getPropertyValue(prop).trim();
		if (prop === 'font-family') family = value.replace(/^['"]|['"]$/g, '');
		else if (prop === 'src') src = value;
		else descriptors[prop] = value;
	}
	out.fonts.push({ family, src, descriptors });
}

/** broadly-scoped selectors (html/body/:root/*) seed the foundation layer. */
function isFoundationSelector(selector: string): boolean {
	return selector
		.split(',')
		.some((s) => /^\s*(\*|:root|html|body)\b/.test(s.trim()) || s.trim() === '*');
}

/** :root / html selectors define document-level custom properties. */
function isRootScope(selector: string): boolean {
	return /(^|,)\s*(:root|html)\s*(,|$)/.test(selector);
}

/** structural check for grouping rules (@layer/@container) without relying on their lib types. */
function isGroupingRule(rule: CSSRule): rule is CSSRule & { cssRules: CSSRuleList } {
	return 'cssRules' in rule && (rule as { cssRules?: unknown }).cssRules instanceof CSSRuleList;
}

/** read an optional string field off a rule object, '' if absent. */
function readField(rule: CSSRule, field: string): string {
	const value = (rule as unknown as Record<string, unknown>)[field];
	return typeof value === 'string' ? value : '';
}

/**
 * computes selector specificity as a*10000 + b*100 + c (section 19.1).
 *
 * a = id count, b = class/attribute/pseudo-class count, c = element/
 * pseudo-element count. this is the classic three-tuple flattened to one number;
 * good enough for cascade ordering in the reconcile phase. pseudo-elements
 * (::before) count toward c, pseudo-classes (:hover) toward b.
 */
export function specificityOf(selector: string): number {
	// score the most specific comma-branch (querySelector semantics).
	let best = 0;
	for (const branch of selector.split(',')) {
		const s = branch.trim();
		const ids = (s.match(/#[\w-]+/g) ?? []).length;
		const classesAttrsPseudo =
			(s.match(/\.[\w-]+/g) ?? []).length +
			(s.match(/\[[^\]]+\]/g) ?? []).length +
			(s.match(/(?<!:):(?!:)[\w-]+/g) ?? []).length;
		const elementsPseudoEl =
			(s.match(/(?:^|[\s>+~])[a-zA-Z][\w-]*/g) ?? []).length + (s.match(/::[\w-]+/g) ?? []).length;
		best = Math.max(best, ids * 10000 + classesAttrsPseudo * 100 + elementsPseudoEl);
	}
	return best;
}
