/**
 * convert/format.ts: html + css pretty-printer (whitespace-safe)
 *
 * Pipeline position: convert
 * Reads from Captured: nothing; operates on the emitted markup + stylesheet strings
 * Writes to Captured: nothing; returns the formatted strings
 *
 * Indentation is the only goal; it must never move a pixel.
 *
 * Why this exists: every emitter returns the clone's outerHTML as a single
 * unindented line and a stylesheet whose rules are serialized one per line by the
 * cssom in clean.ts. Both are correct but unreadable. This module re-emits them in a
 * prettier shape, but only where doing so is provably render-neutral:
 *
 * - Markup is re-serialized one element per indented line, but only where whitespace
 *   collapses to nothing. Whitespace between block boxes collapses, so those children
 *   each take their own line; whitespace around inline content renders as a space, so
 *   any element with inline children or mixed text stays verbatim on one line. A block
 *   element whose only content is text puts that text on its own line; a block trims
 *   its leading/trailing whitespace. Whitespace-sensitive tags/displays (pre,
 *   textarea, white-space:pre*) and the handler-injected style/svg nodes stay verbatim.
 * - The stylesheet is re-emitted one declaration per line. Css is insensitive to
 *   whitespace between declarations and rules, so this never changes rendering.
 * - The reconcile-injected pseudo <style> is lifted out of the markup into the single
 *   head stylesheet, so all css lives in one place. Those rules target pseudo-elements
 *   only, so their cascade position cannot change. Each rule's numeric data-snip-pseudo
 *   marker is then re-keyed to the host element's class where that class is unique, a
 *   more readable selector at the same specificity.
 *
 * The result is the readable form for html-shaped formats; jsx/vue are already indented
 * by their own emitters and are skipped; see isHtmlShaped. The markup walk mirrors
 * convert/jsx.ts's, and like convert/clean.ts every step returns its input unchanged if
 * it will not parse.
 *
 * Deciding what is reflowable needs each element's effective display, and white-space.
 * The html format carries those on the inline style; the class-based formats such as bem-css
 * carry them in the emitted stylesheet, so this reads the css too and maps each flat
 * class rule to its display/white-space. Without it bem markup looks all-block, having no
 * inline styles, so flex/grid containers go undetected and whole subtrees collapse to
 * one line again.
 */
import type { OutputFormat } from '../types';
import { isInjected } from '../reconcile/match';
import { composeDocument } from './html';

/** Html5 void elements: no closing tag, no children. */
const VOID_TAGS = new Set([
	'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
	'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/**
 * Inline-level tags whose surrounding whitespace renders. A static allowlist,
 * since getComputedStyle is unreliable on the detached parse tree; everything not listed,
 * including unknown/custom elements, is treated as block.
 */
const INLINE_TAGS = new Set([
	'a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'dfn', 'del', 'em',
	'i', 'ins', 'kbd', 'mark', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub',
	'sup', 'time', 'u', 'var', 'wbr', 'button', 'img', 'input', 'select', 'textarea',
	'label', 'output', 'big', 'tt', 'font', 'picture', 'audio', 'video', 'object', 'svg',
]);

/** Tags whose inner whitespace is significant; their content is emitted verbatim. */
const WS_SENSITIVE = new Set(['pre', 'textarea', 'code', 'script', 'style', 'svg']);

/** Computed white-space values that preserve whitespace, so text must stay verbatim. */
const PRESERVED_WS = new Set(['pre', 'pre-wrap', 'pre-line', 'break-spaces']);

/** The html-shaped output formats the formatter applies to; jsx/vue self-indent. */
const HTML_SHAPED = new Set<OutputFormat>(['html', 'tailwind', 'bem-css', 'bem-scss']);

/** A bare css identifier that needs no escaping, so a class is safe to use as a selector verbatim. */
const BARE_IDENT = /^-?[A-Za-z_][\w-]*$/;

/** The resting display + white-space a flat class rule declares, for reflow decisions. */
interface ClassStyle {
	display?: string;
	whiteSpace?: string;
}

/** Whether a format emits html-shaped markup that the formatter should indent. */
export function isHtmlShaped(format: OutputFormat): boolean {
	return HTML_SHAPED.has(format);
}

/**
 * Assembles the final self-contained document for an html-shaped format: lifts the
 * reconcile-injected pseudo <style> out of the markup into the single head stylesheet,
 * pretty-prints the markup and the stylesheet, and composes them. Render-neutral
 * throughout; see liftEmbeddedStyles, formatHtmlMarkup, and formatCss.
 *
 * @param html - the polished markup, possibly carrying an injected pseudo <style>
 * @param css - the polished head stylesheet
 * @param warnings - appended to on a markup parse failure
 * @returns the formatted markup, the formatted + merged stylesheet, and the composed document
 */
export function assembleHtmlDocument(html: string, css: string, warnings: string[]): { html: string; css: string; document: string } {
	const lifted = liftEmbeddedStyles(html);
	// Re-key the lifted pseudo and state rules from their numeric markers to the host
	// element's class where that class is unique, so the output reads `.date-field::placeholder`
	// and `.btn:hover .icon` rather than `[data-snip-pseudo="0"]::placeholder` and
	// `[data-snip-state="0"]:hover [data-snip-state="1"]`, and the now-redundant marker
	// attributes are dropped from the markup.
	const keyedPseudo = keyMarkersToClasses(lifted.markup, lifted.css, 'data-snip-pseudo');
	const keyed = keyMarkersToClasses(keyedPseudo.markup, keyedPseudo.css, 'data-snip-state');
	const formattedHtml = formatHtmlMarkup(keyed.markup, css, warnings);
	// The pseudo rules are already one-declaration-per-line from features/pseudo.ts and
	// carry only a marker or a unique-class selector, so they are appended after the
	// formatted class rules without re-parsing, which keeps them intact verbatim.
	const mergedCss = [formatCss(css).trim(), keyed.css.trim()].filter(Boolean).join('\n\n');
	return { html: formattedHtml, css: mergedCss, document: composeDocument(formattedHtml, mergedCss) };
}

/**
 * Lifts every reconcile-injected <style> out of the markup, returning the markup
 * without those nodes plus their concatenated css. The pseudo handler appends a
 * <style> of [data-snip-pseudo]::x rules inside the clone, so without this the output
 * carries css both before the markup, in the head block, and after it, in the injected node.
 *
 * @param html - the emitted markup
 * @returns the markup with <style> nodes removed, and their concatenated css
 */
function liftEmbeddedStyles(html: string): { markup: string; css: string } {
	try {
		const doc = new DOMParser().parseFromString(html, 'text/html');
		const styles = Array.from(doc.body.querySelectorAll('style'));
		if (styles.length === 0) return { markup: html, css: '' };
		const css = styles.map((s) => s.textContent ?? '').filter((t) => t.trim()).join('\n\n');
		for (const style of styles) style.remove();
		return { markup: doc.body.innerHTML, css };
	} catch {
		return { markup: html, css: '' };
	}
}

/**
 * Re-keys lifted rules from a numeric marker attribute to the host element's class, when
 * that class uniquely identifies the element. This turns `[data-snip-pseudo="0"]::placeholder`
 * into the far more readable `.date-field::placeholder` and a multi-marker state selector
 * `[data-snip-state="0"]:hover [data-snip-state="1"]` into `.btn:hover .icon`, and drops the
 * now-redundant marker attribute. Every reference to a re-keyed marker is replaced, so a
 * selector that names the marker more than once, a trigger and its pseudo pair, is fully
 * rewritten. An element whose class is shared, absent, or not a bare identifier keeps its
 * marker, so a rule can never leak onto a sibling. Render-neutral: a unique class selects
 * exactly the marked element at the same specificity as the attribute selector.
 *
 * @param markup - the lifted markup, with the injected <style> already removed
 * @param css - the lifted rules, keyed by the marker attribute
 * @param attr - the marker attribute, data-snip-pseudo or data-snip-state
 * @returns the markup with redundant markers removed and the re-keyed css; inputs are
 *   unchanged if the markup will not parse
 */
function keyMarkersToClasses(markup: string, css: string, attr: string): { markup: string; css: string } {
	if (!css.trim()) return { markup, css };
	try {
		const doc = new DOMParser().parseFromString(markup, 'text/html');
		const marked = Array.from(doc.body.querySelectorAll(`[${attr}]`));
		if (marked.length === 0) return { markup, css };

		// A class identifies a single element when it is borne by exactly one element.
		const classCounts = new Map<string, number>();
		for (const el of doc.body.querySelectorAll('[class]')) {
			for (const name of el.classList) classCounts.set(name, (classCounts.get(name) ?? 0) + 1);
		}

		let out = css;
		for (const el of marked) {
			const id = el.getAttribute(attr);
			if (id === null) continue;
			const unique = Array.from(el.classList).find((name) => classCounts.get(name) === 1 && BARE_IDENT.test(name));
			if (!unique) continue; // Shared, unnamed, or unsafe class: keep the numeric marker
			// Literal global replace keeps the regex-special `["]` characters intact.
			out = out.split(`[${attr}="${id}"]`).join(`.${unique}`);
			el.removeAttribute(attr);
		}
		return { markup: doc.body.innerHTML, css: out };
	} catch {
		return { markup, css };
	}
}

/**
 * Pretty-prints emitted html markup, indenting only where it is render-neutral.
 *
 * @param html - the emitted markup, one element with no injected style after liftEmbeddedStyles
 * @param css - the emitted stylesheet, read for class-based display, empty for html
 * @param warnings - appended to on a parse failure, after which the input is returned as-is
 * @returns the indented markup, or the input unchanged if it will not parse
 */
export function formatHtmlMarkup(html: string, css: string, warnings: string[]): string {
	try {
		const doc = new DOMParser().parseFromString(html, 'text/html');
		const roots = Array.from(doc.body.children);
		if (roots.length === 0) {
			warnings.push('format: markup unparseable, left unformatted');
			return html;
		}
		const classStyle = classStyleMap(css);
		return roots.map((el) => formatElement(el, 0, classStyle)).join('\n');
	} catch {
		warnings.push('format: markup unparseable, left unformatted');
		return html;
	}
}

/**
 * Pretty-prints a stylesheet with one declaration per line and a blank line between
 * rules. Render-neutral: css is insensitive to whitespace between declarations and
 * rules. Re-parses via the cssom, as clean.ts does, for robust handling of @font-face,
 * @keyframes, @media, and pseudo rules; declarations are split from the rule's own
 * serialized text, never re-derived, so shorthands are preserved exactly. Returns the
 * input unchanged if it will not parse.
 *
 * @param css - the stylesheet text to format
 * @returns the multi-line stylesheet
 */
export function formatCss(css: string): string {
	if (!css.trim()) return css;
	let sheet: CSSStyleSheet;
	try {
		sheet = new CSSStyleSheet();
		sheet.replaceSync(css);
	} catch {
		return css;
	}
	return Array.from(sheet.cssRules).map((rule) => formatCssRule(rule, 0)).join('\n\n');
}

/** Serialize one css rule with each declaration on its own indented line. */
function formatCssRule(rule: CSSRule, depth: number): string {
	const pad = '\t'.repeat(depth);
	if (rule instanceof CSSStyleRule) {
		return `${pad}${rule.selectorText} {\n${declarationLines(rule.style.cssText, depth + 1)}\n${pad}}`;
	}
	if (rule instanceof CSSFontFaceRule) {
		return `${pad}@font-face {\n${declarationLines(rule.style.cssText, depth + 1)}\n${pad}}`;
	}
	if (rule instanceof CSSKeyframeRule) {
		return `${pad}${rule.keyText} {\n${declarationLines(rule.style.cssText, depth + 1)}\n${pad}}`;
	}
	if (rule instanceof CSSKeyframesRule) {
		const frames = Array.from(rule.cssRules).map((frame) => formatCssRule(frame, depth + 1)).join('\n');
		return `${pad}@keyframes ${rule.name} {\n${frames}\n${pad}}`;
	}
	if (rule instanceof CSSMediaRule || rule instanceof CSSSupportsRule) {
		const cond = rule instanceof CSSMediaRule ? `@media ${rule.conditionText}` : `@supports ${rule.conditionText}`;
		const inner = Array.from(rule.cssRules).map((child) => formatCssRule(child, depth + 1)).join('\n\n');
		return `${pad}${cond} {\n${inner}\n${pad}}`;
	}
	// Any other at-rule, handled by shape rather than by name so none is left on one line: a
	// braceless statement (@import, @charset, @layer with a name list) has no body and is
	// emitted as-is; a grouping at-rule (@container, @layer block, @scope) carries child rules
	// and is recursed under its own prelude, the text before the block brace, like @media above;
	// a declaration at-rule (@property, @counter-style, @page) carries a descriptor body, split
	// one per line with the shared helper. Whitespace between css declarations and rules is
	// insignificant, so every branch is render-neutral.
	const brace = rule.cssText.indexOf('{');
	if (brace === -1) return `${pad}${rule.cssText}`;
	const prelude = rule.cssText.slice(0, brace).trim();
	if ('cssRules' in rule) {
		const inner = Array.from((rule as CSSGroupingRule).cssRules).map((child) => formatCssRule(child, depth + 1)).join('\n\n');
		return `${pad}${prelude} {\n${inner}\n${pad}}`;
	}
	const body = rule.cssText.slice(brace + 1, rule.cssText.lastIndexOf('}'));
	return `${pad}${prelude} {\n${declarationLines(body, depth + 1)}\n${pad}}`;
}

/**
 * Splits a serialized declaration block ("a: b; c: d;") into one indented `prop: value;`
 * line each. Splits on top-level semicolons only, so a `;` inside a url(), function, or
 * string, such as a data uri or a quoted family, never splits a declaration.
 *
 * @param block - the cssom-serialized declaration block, with no braces
 * @param depth - the indent depth for each line
 */
function declarationLines(block: string, depth: number): string {
	const pad = '\t'.repeat(depth);
	const decls: string[] = [];
	let current = '';
	let parens = 0;
	let quote: string | null = null;
	for (const ch of block) {
		if (quote) {
			current += ch;
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") quote = ch;
		else if (ch === '(') parens++;
		else if (ch === ')') parens--;
		else if (ch === ';' && parens === 0) {
			if (current.trim()) decls.push(`${pad}${current.trim()};`);
			current = '';
			continue;
		}
		current += ch;
	}
	if (current.trim()) decls.push(`${pad}${current.trim()};`);
	return decls.join('\n');
}

/**
 * Maps each class to its resting display + white-space by parsing the emitted
 * stylesheet. Only flat single-class rules count: a selector that is one `.<class>`
 * with no combinator, no `:pseudo`, and no comma, followed by a block. That deliberately skips
 * @font-face/@keyframes, the polish :hover/:focus-visible rules, and comma/descendant
 * selectors, so a class's resting style is never confused with a state rule. The html
 * format, which has no class rules, yields an empty map and falls back to inline styles; the
 * nested bem-scss output never matches the flat pattern and simply yields no info,
 * which is safe, just less indented. The flat bem-css default does match.
 *
 * @param css - the emitted stylesheet
 * @returns a class-name -> resting display/white-space map
 */
function classStyleMap(css: string): Map<string, ClassStyle> {
	const map = new Map<string, ClassStyle>();
	const ruleRe = /\.([A-Za-z_][-\w]*)\s*\{([^{}]*)\}/g;
	let rule: RegExpExecArray | null;
	while ((rule = ruleRe.exec(css))) {
		const className = rule[1];
		const body = rule[2];
		if (!className || body === undefined) continue;
		const entry = map.get(className) ?? {};
		const display = /(?:^|;)\s*display\s*:\s*([^;]+)/i.exec(body);
		if (display?.[1]) entry.display = display[1].trim().toLowerCase();
		const whiteSpace = /(?:^|;)\s*white-space\s*:\s*([^;]+)/i.exec(body);
		if (whiteSpace?.[1]) entry.whiteSpace = whiteSpace[1].trim().toLowerCase();
		map.set(className, entry);
	}
	return map;
}

/** Recursively serialize an element with one reflowable child per indented line. */
function formatElement(el: Element, depth: number, classStyle: Map<string, ClassStyle>): string {
	const pad = '\t'.repeat(depth);
	const tag = el.tagName.toLowerCase();
	const open = `<${tag}${attrs(el)}>`;

	// Void elements have no close tag and no children.
	if (VOID_TAGS.has(tag)) return `${pad}${open}`;
	if (el.childNodes.length === 0) return `${pad}${open}</${tag}>`;

	// A block element whose only content is text: put the trimmed text on its own line.
	// A block trims its leading/trailing whitespace, so this is render-neutral; inline or
	// white-space-preserving elements keep their text inline, since their edge whitespace can
	// render, or every space is significant.
	if (isTextOnlyBlock(el, classStyle)) {
		return `${pad}${open}\n${pad}\t${(el.textContent ?? '').trim()}\n${pad}</${tag}>`;
	}

	// Not reflowable: inline content, mixed text, or a whitespace-sensitive tag. Emit the
	// inner html verbatim on one line so no rendered whitespace can shift.
	if (!isReflowable(el, classStyle)) return `${pad}${open}${el.innerHTML}</${tag}>`;

	// Reflowable: all-block children with no significant text, so each child can take its
	// own indented line, since collapsed whitespace between block boxes renders nothing.
	const childLines = Array.from(el.children).map((child) => formatElement(child, depth + 1, classStyle));
	return `${pad}${open}\n${childLines.join('\n')}\n${pad}</${tag}>`;
}

/**
 * Whether an element is a block-level box whose only content is significant text, so
 * the text can move to its own line without changing rendering. False for inline,
 * white-space-preserving, or whitespace-sensitive elements, and for any element with an
 * element child.
 */
function isTextOnlyBlock(el: Element, classStyle: Map<string, ClassStyle>): boolean {
	if (WS_SENSITIVE.has(el.tagName.toLowerCase())) return false;
	if (isInline(el, classStyle) || preservesWhitespace(el, classStyle)) return false;
	let hasText = false;
	for (const node of Array.from(el.childNodes)) {
		if (node.nodeType === Node.ELEMENT_NODE) return false;
		if (node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '') hasText = true;
	}
	return hasText;
}

/**
 * Whether putting each child of `el` on its own line cannot shift rendering. True only
 * for elements whose children are all block-level with no significant text; false for
 * whitespace-sensitive tags, mixed inline content, or any inline child.
 */
function isReflowable(el: Element, classStyle: Map<string, ClassStyle>): boolean {
	if (WS_SENSITIVE.has(el.tagName.toLowerCase())) return false;
	// A flex or grid container blockifies its children and discards the whitespace-only
	// text between them, so each element child can take its own line regardless of its
	// own display. Outside such a container an inline child's surrounding whitespace
	// renders, so any inline child forces the verbatim path.
	const itemsBlockified = establishesFlexOrGrid(el, classStyle);
	let hasElementChild = false;
	for (const node of Array.from(el.childNodes)) {
		if (node.nodeType === Node.TEXT_NODE) {
			if ((node.textContent ?? '').trim() !== '') return false; // significant text: keep inline
		} else if (node.nodeType === Node.ELEMENT_NODE) {
			const child = node as Element;
			// Injected style/svg nodes are not part of the rendered inline flow: a <style>
			// renders nothing, and the icons sprite is absolutely positioned and zero-size, so
			// reflowing around them is safe.
			if (isInjected(child)) continue;
			if (!itemsBlockified && isInline(child, classStyle)) return false;
			hasElementChild = true;
		}
	}
	return hasElementChild;
}

/**
 * The value of one resting style property: its inline-style value if present, as in the html
 * format, else the value from the first of its classes the stylesheet declares one for,
 * as in the bem-css format, else '' when unknown. Routing both display and white-space through
 * one reader lets the same reflow logic serve the inline-styled and class-based formats.
 *
 * @param el - the element to resolve
 * @param prop - the property to read (display or white-space)
 * @param classStyle - class-name -> resting style from the emitted stylesheet
 * @param pick - selects the property off a class's resting style
 * @returns the lowercased value, or '' if none is known
 */
function restingValue(el: Element, prop: string, classStyle: Map<string, ClassStyle>, pick: (s: ClassStyle) => string | undefined): string {
	const inline = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'i').exec(el.getAttribute('style') ?? '');
	if (inline?.[1]) return inline[1].trim().toLowerCase();
	for (const className of Array.from(el.classList)) {
		const value = pick(classStyle.get(className) ?? {});
		if (value) return value;
	}
	return '';
}

/** Whether an element's effective display makes it a flex or grid container. */
function establishesFlexOrGrid(el: Element, classStyle: Map<string, ClassStyle>): boolean {
	const display = restingValue(el, 'display', classStyle, (s) => s.display);
	return display === 'flex' || display === 'grid' || display === 'inline-flex' || display === 'inline-grid';
}

/** Whether an element's effective white-space preserves whitespace, so text is significant. */
function preservesWhitespace(el: Element, classStyle: Map<string, ClassStyle>): boolean {
	return PRESERVED_WS.has(restingValue(el, 'white-space', classStyle, (s) => s.whiteSpace));
}

/**
 * Whether an element is inline-level. Uses the static allowlist, then a one-way
 * refinement that never upgrades: an effective display of inline* downgrades an
 * otherwise-block tag, closing the only realistic regression, an author display:inline
 * on a div. The display comes from the inline style for html or the element's class
 * rules for bem-css; without either, only the allowlist applies.
 */
function isInline(el: Element, classStyle: Map<string, ClassStyle>): boolean {
	if (INLINE_TAGS.has(el.tagName.toLowerCase())) return true;
	return restingValue(el, 'display', classStyle, (s) => s.display).startsWith('inline');
}

/** Build the attribute string for an open tag, escaping & and " like a serializer. */
function attrs(el: Element): string {
	const parts: string[] = [];
	for (const attr of Array.from(el.attributes)) {
		const value = attr.value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
		parts.push(`${attr.name}="${value}"`);
	}
	return parts.length ? ' ' + parts.join(' ') : '';
}
