/**
 * convert/jsx.ts: html -> jsx (react)
 *
 * Pipeline position: convert
 * Reads from Captured: clone (via the tailwind/bem emitters)
 * Writes to Captured: nothing
 *
 * A format transform of the baked result.
 *
 * Why this exists: the jsx-tailwind and jsx-css formats emit a
 * react component. Jsx is not html: attributes rename (class -> className, for ->
 * htmlFor, hyphenated svg attrs camelCase), void elements self-close, and inline
 * style strings become style objects. This builds on the tailwind emitter
 * (jsx-tailwind) or the bem-css emitter (jsx-css), then rewrites their html into
 * jsx and wraps it in a component. Ported (rewritten) from v1 html-to-jsx.ts
 * (full attribute transform table). Jsx lets any childless element self-close,
 * so there is no need to enumerate html void elements (which also avoids
 * hardcoding a tag list).
 */
import type { Captured } from '../types';
import { emitTailwind } from './tailwind';
import { emitBem } from './bem';
import type { HtmlOutput } from './html';

/**
 * The html attributes that rename to a non-camelCase react prop. This is the
 * react dom attribute vocabulary (a finite output-format table), not a hardcoded
 * list of styling properties. Hyphenated svg attrs are handled algorithmically (camelCase).
 */
const REACT_ATTR: Record<string, string> = {
	class: 'className',
	for: 'htmlFor',
	tabindex: 'tabIndex',
	readonly: 'readOnly',
	maxlength: 'maxLength',
	minlength: 'minLength',
	autocomplete: 'autoComplete',
	autofocus: 'autoFocus',
	contenteditable: 'contentEditable',
	crossorigin: 'crossOrigin',
	enctype: 'encType',
	formaction: 'formAction',
	novalidate: 'noValidate',
	spellcheck: 'spellCheck',
	srcset: 'srcSet',
	colspan: 'colSpan',
	rowspan: 'rowSpan',
	usemap: 'useMap',
};

/**
 * Emits the snip as a react component plus its stylesheet.
 *
 * @param captured - read-only
 * @param variant - 'tailwind' (className utilities) or 'css' (bem classes + css)
 */
export function emitJsx(captured: Captured, variant: 'tailwind' | 'css'): HtmlOutput {
	const base = variant === 'tailwind' ? emitTailwind(captured) : emitBem(captured, false);
	const doc = new DOMParser().parseFromString(base.html, 'text/html');
	const root = doc.body.firstElementChild;
	const jsx = root ? elementToJsx(root, 3) : 'null';
	const component = `export default function Snippet() {\n\treturn (\n${jsx}\n\t);\n}`;
	return { html: component, css: base.css };
}

/** Recursively serialize an element (and its children) as indented jsx. */
function elementToJsx(el: Element, depth: number): string {
	const pad = '\t'.repeat(depth);
	const tag = el.tagName.toLowerCase();
	const attrs = attrsToJsx(el);
	const children = childrenToJsx(el, depth + 1);

	// Jsx allows self-closing any childless element, void or not.
	if (children === '') return `${pad}<${tag}${attrs} />`;
	return `${pad}<${tag}${attrs}>\n${children}\n${pad}</${tag}>`;
}

/** Serialize child element + text nodes as jsx, dropping empty whitespace. */
function childrenToJsx(el: Element, depth: number): string {
	const pad = '\t'.repeat(depth);
	const out: string[] = [];
	for (const node of Array.from(el.childNodes)) {
		if (node.nodeType === Node.ELEMENT_NODE) {
			out.push(elementToJsx(node as Element, depth));
		} else if (node.nodeType === Node.TEXT_NODE) {
			const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
			if (text) out.push(`${pad}${escapeJsxText(text)}`);
		}
	}
	return out.join('\n');
}

/** Build the jsx attribute string for an element. */
function attrsToJsx(el: Element): string {
	const parts: string[] = [];
	for (const attr of Array.from(el.attributes)) {
		const name = jsxAttrName(attr.name);
		if (attr.name === 'style') {
			parts.push(`style={{${styleToObject(attr.value)}}}`);
		} else {
			parts.push(`${name}="${escapeAttr(attr.value)}"`);
		}
	}
	return parts.length ? ' ' + parts.join(' ') : '';
}

/** Map an html attribute name to its react prop name. */
function jsxAttrName(name: string): string {
	if (name.startsWith('data-') || name.startsWith('aria-')) return name; // Kept verbatim in react
	const renamed = REACT_ATTR[name];
	if (renamed) return renamed;
	if (name.includes('-')) return camelCase(name); // Svg attrs: stroke-width -> strokeWidth
	return name;
}

/** Convert an inline style string to react style-object entries. */
function styleToObject(style: string): string {
	const entries: string[] = [];
	for (const decl of style.split(';')) {
		const idx = decl.indexOf(':');
		if (idx < 0) continue;
		const prop = decl.slice(0, idx).trim();
		const value = decl.slice(idx + 1).trim();
		if (!prop) continue;
		// Custom properties keep their literal name and must be quoted as a key.
		const key = prop.startsWith('--') ? `'${prop}'` : camelCase(prop);
		entries.push(`${key}: '${value.replace(/'/g, "\\'")}'`);
	}
	return entries.join(', ');
}

/** Hyphenated -> camelCase (stroke-width -> strokeWidth). */
function camelCase(name: string): string {
	return name.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
}

/** Escape a jsx attribute value (double-quoted). */
function escapeAttr(value: string): string {
	return value.replace(/"/g, '&quot;');
}

/** Escape jsx text so braces are not read as expressions. */
function escapeJsxText(text: string): string {
	return text.replace(/[{}]/g, (c) => `{'${c}'}`);
}
