/**
 * reconcile/selector.ts: a compound/combinator css selector parser
 *
 * Pipeline position: reconcile (a leaf utility, used by features/states.ts)
 * Reads from Captured: nothing (operates on selector strings)
 * Writes to Captured: nothing (pure)
 *
 * Why this exists: re-anchoring an interactive-state rule (`.nav > .btn:hover`)
 * to a standalone artifact means taking it apart structurally, which compound is
 * the subject, which compounds carry a `:hover`/`:focus`/`:active`, and how they are
 * joined. A regex cannot do that safely: a selector nests parens (`:is(.a, .b)`,
 * `:nth-child(2n+1)`), brackets (`[href="a > b"]`), and strings, any of which can
 * hide a comma, a combinator, or a colon. So this is a real (if small) parser that
 * walks the string with paren/bracket/quote depth tracking, the same job the vendored
 * `parsel` micro-parser does, kept here with no node dependency.
 *
 * It is deliberately structural-only: it identifies compounds, the combinators
 * between them, each compound's dynamic interactive pseudo-classes, and any
 * pseudo-element. It does not validate that a selector is well-formed beyond
 * balanced delimiters; the live `element.matches()` in the caller is the real
 * arbiter (an unsupported `:has()` argument throws there and the caller drops the
 * rule). Anything with unbalanced delimiters throws a SyntaxError so the caller can
 * drop + warn rather than emit a broken selector.
 */

/** A combinator between two compounds: descendant (space), child, next-sibling, subsequent-sibling. */
export type Combinator = ' ' | '>' | '+' | '~';

/**
 * The interactive pseudo-classes whose state is not present in a resting capture, so
 * a rule using one is silently dropped by the resting cascade. This is the closed
 * css-spec set states.ts reproduces; the form-state pseudos (`:checked`, `:disabled`)
 * are excluded deliberately because they reflect current dom state already captured
 * at rest.
 */
export const DYNAMIC_PSEUDOS = new Set([':hover', ':focus', ':focus-visible', ':focus-within', ':active']);

/** Legacy single-colon spellings of pseudo-elements, normalized to `::` on parse. */
const LEGACY_PSEUDO_ELEMENTS = new Set([':before', ':after', ':first-line', ':first-letter']);

/** One compound selector: a run of simple selectors with no combinator between them. */
export interface Compound {
	/** The compound's source text, verbatim. */
	raw: string;
	/**
	 * The compound reduced to its structural simple selectors (tag, class, id,
	 * attribute, and structural pseudo-classes like `:nth-child`), with the dynamic
	 * interactive pseudo-classes and any pseudo-element removed. This is the form
	 * matched against a live element to bind the compound. An empty string means the
	 * compound has no structural part (a bare `:hover`), which matches any element.
	 */
	structural: string;
	/** The dynamic interactive pseudo-classes at this compound's top level, e.g. `[':hover']`. */
	dynamicPseudos: string[];
	/** The pseudo-element this compound targets (normalized to `::name`), or '' if none. */
	pseudoElement: string;
}

/** One complex selector: compounds left-to-right, joined by combinators. */
export interface Complex {
	/** The compounds, in source (left-to-right) order. The last is the subject. */
	compounds: Compound[];
	/** combinators[i] joins compounds[i] to compounds[i + 1]; length is compounds.length - 1. */
	combinators: Combinator[];
}

/** Whitespace characters that separate tokens at the top level of a selector. */
const WS = new Set([' ', '\t', '\n', '\r', '\f']);

/** The explicit combinator characters. */
const COMBINATOR_CHARS = new Set(['>', '+', '~']);

/** Identifier characters (unescaped) in a css name, class, id, tag, or pseudo name. */
function isIdentChar(ch: string): boolean {
	return /[A-Za-z0-9_-]/.test(ch) || ch.charCodeAt(0) >= 0x80;
}

/**
 * Cheap pre-filter: whether a selector mentions any dynamic interactive pseudo-class
 * at all. Used to skip the full parse for the overwhelming majority of rules that
 * carry none. A false positive (the token appears inside a string or comment) only
 * costs a parse that then finds nothing, never a wrong result.
 *
 * @param selector - the rule selector text
 */
export function containsDynamicPseudo(selector: string): boolean {
	return /:(?:hover|focus|focus-visible|focus-within|active)\b/.test(selector);
}

/**
 * Parses a selector list into its complex selectors. Splits on top-level commas, then
 * each complex selector into compounds and combinators.
 *
 * @param selector - a full selector, possibly a comma list
 * @returns one Complex per comma branch
 * @throws SyntaxError on unbalanced parens, brackets, or quotes
 */
export function parseSelectorList(selector: string): Complex[] {
	return splitTopLevel(selector, ',').map(parseComplex);
}

/**
 * Parses one complex selector (no top-level comma) into compounds + combinators.
 *
 * @param complex - a single complex selector
 * @returns the parsed compounds and the combinators between them
 * @throws SyntaxError on unbalanced delimiters
 */
export function parseComplex(complex: string): Complex {
	const { compoundTexts, combinators } = splitCompounds(complex);
	const compounds = compoundTexts.map(analyzeCompound);
	return { compounds, combinators };
}

/**
 * Splits a complex selector into compound texts and the combinators between them,
 * tracking delimiter depth so a combinator-looking character inside `[...]`, `(...)`,
 * or a string is never treated as a combinator.
 *
 * @param s - a single complex selector
 * @throws SyntaxError on unbalanced delimiters
 */
function splitCompounds(s: string): { compoundTexts: string[]; combinators: Combinator[] } {
	const compoundTexts: string[] = [];
	const combinators: Combinator[] = [];
	let cur = '';
	let i = 0;
	let depth = 0;
	let quote: string | null = null;

	while (i < s.length) {
		const ch = s[i] as string;
		if (quote) {
			cur += ch;
			if (ch === quote) quote = null;
			else if (ch === '\\') { cur += s[i + 1] ?? ''; i++; }
			i++;
			continue;
		}
		if (ch === '"' || ch === "'") { quote = ch; cur += ch; i++; continue; }
		if (ch === '(' || ch === '[') { depth++; cur += ch; i++; continue; }
		if (ch === ')' || ch === ']') { depth--; cur += ch; i++; continue; }
		if (ch === '\\') { cur += ch + (s[i + 1] ?? ''); i += 2; continue; }

		if (depth === 0 && (WS.has(ch) || COMBINATOR_CHARS.has(ch))) {
			// A combinator boundary: consume the whole run of whitespace and at most one
			// explicit combinator. The run is a descendant combinator unless it contains an
			// explicit one, in which case that wins (whitespace around it is just padding).
			let comb: Combinator = ' ';
			while (i < s.length) {
				const c = s[i] as string;
				if (WS.has(c)) { i++; continue; }
				if (COMBINATOR_CHARS.has(c)) { comb = c as Combinator; i++; continue; }
				break;
			}
			if (cur.trim() !== '') {
				compoundTexts.push(cur.trim());
				combinators.push(comb);
				cur = '';
			}
			continue;
		}
		cur += ch;
		i++;
	}
	if (depth !== 0 || quote) throw new SyntaxError(`unbalanced selector: ${s}`);
	if (cur.trim() !== '') compoundTexts.push(cur.trim());
	// A trailing combinator with no following compound (e.g. "a >") is dangling; drop it.
	if (combinators.length >= compoundTexts.length) combinators.length = Math.max(0, compoundTexts.length - 1);
	return { compoundTexts, combinators };
}

/**
 * Splits a string on a single top-level delimiter character, ignoring occurrences
 * inside parens, brackets, or strings.
 *
 * @param s - the string to split
 * @param delim - the single-character delimiter (here, ',')
 * @throws SyntaxError on unbalanced delimiters
 */
function splitTopLevel(s: string, delim: string): string[] {
	const out: string[] = [];
	let cur = '';
	let depth = 0;
	let quote: string | null = null;
	for (let i = 0; i < s.length; i++) {
		const ch = s[i] as string;
		if (quote) {
			cur += ch;
			if (ch === quote) quote = null;
			else if (ch === '\\') { cur += s[i + 1] ?? ''; i++; }
			continue;
		}
		if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
		if (ch === '(' || ch === '[') { depth++; cur += ch; continue; }
		if (ch === ')' || ch === ']') { depth--; cur += ch; continue; }
		if (ch === '\\') { cur += ch + (s[i + 1] ?? ''); i++; continue; }
		if (ch === delim && depth === 0) { out.push(cur); cur = ''; continue; }
		cur += ch;
	}
	if (depth !== 0 || quote) throw new SyntaxError(`unbalanced selector: ${s}`);
	out.push(cur);
	return out.map((t) => t.trim()).filter((t) => t !== '');
}

/**
 * Analyzes one compound into its structural part, its dynamic interactive
 * pseudo-classes, and any pseudo-element. The structural part is what binds the
 * compound to a live element; the dynamic pseudos and pseudo-element are what the
 * re-anchored output rule keeps after the structural part is replaced by a marker.
 *
 * @param raw - the compound's source text
 */
function analyzeCompound(raw: string): Compound {
	const structuralParts: string[] = [];
	const dynamicPseudos: string[] = [];
	let pseudoElement = '';

	for (const piece of tokenizeSimpleSelectors(raw)) {
		const kind = classifyPiece(piece);
		if (kind === 'pseudo-element') {
			pseudoElement += normalizePseudoElement(piece);
		} else if (kind === 'dynamic-pseudo') {
			dynamicPseudos.push(piece.toLowerCase());
		} else {
			structuralParts.push(piece);
		}
	}
	return { raw, structural: structuralParts.join(''), dynamicPseudos, pseudoElement };
}

/** Whether a simple-selector piece is a pseudo-element, a dynamic pseudo-class, or structural. */
function classifyPiece(piece: string): 'pseudo-element' | 'dynamic-pseudo' | 'structural' {
	if (piece.startsWith('::')) return 'pseudo-element';
	if (piece.startsWith(':')) {
		const name = pseudoName(piece);
		if (LEGACY_PSEUDO_ELEMENTS.has(name)) return 'pseudo-element';
		if (DYNAMIC_PSEUDOS.has(name)) return 'dynamic-pseudo';
	}
	return 'structural';
}

/** The bare `:name` of a pseudo (no arguments), lowercased, for set lookup. */
function pseudoName(piece: string): string {
	const colons = piece.startsWith('::') ? '::' : ':';
	const rest = piece.slice(colons.length);
	const paren = rest.indexOf('(');
	const name = (paren === -1 ? rest : rest.slice(0, paren)).toLowerCase();
	return `:${name}`;
}

/** Normalize a pseudo-element to its `::name` spelling (folds legacy single-colon forms). */
function normalizePseudoElement(piece: string): string {
	return piece.startsWith('::') ? piece : `:${piece}`;
}

/**
 * Splits a compound into its individual simple selectors (`*`, tag, `.class`, `#id`,
 * `[attr]`, `:pseudo`, `::pseudo-element`), tracking paren/bracket depth and escapes
 * so a delimiter inside `[...]` or `(...)` never starts a new piece.
 *
 * @param compound - the compound text (no combinators)
 */
function tokenizeSimpleSelectors(compound: string): string[] {
	const pieces: string[] = [];
	let i = 0;
	while (i < compound.length) {
		const ch = compound[i] as string;
		if (WS.has(ch)) { i++; continue; }
		const start = i;
		if (ch === '[') {
			i = skipBalanced(compound, i, '[', ']');
		} else if (ch === ':') {
			// Pseudo-class or pseudo-element: the colon(s), an identifier, and an optional
			// balanced argument list.
			i++;
			if (compound[i] === ':') i++;
			i = readIdent(compound, i);
			if (compound[i] === '(') i = skipBalanced(compound, i, '(', ')');
		} else if (ch === '.' || ch === '#') {
			i = readIdent(compound, i + 1);
		} else if (ch === '*' || ch === '&') {
			i++;
		} else {
			// A type (tag) selector, optionally namespaced (ns|tag).
			i = readIdent(compound, i);
			if (compound[i] === '|') i = readIdent(compound, i + 1);
		}
		if (i <= start) i = start + 1; // Defensive: never fail to advance.
		pieces.push(compound.slice(start, i));
	}
	return pieces;
}

/** Advance past a run of identifier characters (and escapes) from `i`. */
function readIdent(s: string, i: number): number {
	while (i < s.length) {
		const ch = s[i] as string;
		if (ch === '\\') { i += 2; continue; }
		if (isIdentChar(ch)) { i++; continue; }
		break;
	}
	return i;
}

/** Advance past a balanced `open`/`close` delimited run (e.g. `[...]`, `(...)`), quote-aware. */
function skipBalanced(s: string, i: number, open: string, close: string): number {
	let depth = 0;
	let quote: string | null = null;
	for (; i < s.length; i++) {
		const ch = s[i] as string;
		if (quote) {
			if (ch === quote) quote = null;
			else if (ch === '\\') i++;
			continue;
		}
		if (ch === '"' || ch === "'") quote = ch;
		else if (ch === '\\') i++;
		else if (ch === open) depth++;
		else if (ch === close) {
			depth--;
			if (depth === 0) return i + 1;
		}
	}
	return i; // Unbalanced: splitCompounds/splitTopLevel already guard the whole string.
}
