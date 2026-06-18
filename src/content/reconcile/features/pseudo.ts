/**
 * features/pseudo.ts: generated-content pseudo-elements
 *
 * Pipeline position: reconcile
 * Reads from Captured: root, clone
 * Writes to Captured: clone (marks elements + appends a <style> of pseudo rules)
 *
 * Extends the "ship what renders" approach to pseudo-elements, which inline
 * styles cannot express.
 *
 * CSS/spec reference: https://developer.mozilla.org/en-US/docs/Web/CSS/Pseudo-elements
 * Detection criterion: ::before/::after with computed content other than `none`;
 * ::marker on display:list-item elements; ::placeholder on elements with a
 * placeholder attribute; ::file-selector-button on file inputs.
 * Transform contract: tags the matching clone element with a data-snip-pseudo marker
 * and appends one <style> to the clone carrying `[data-snip-pseudo="n"]::x {... }`
 * rules snapshotted from the live pseudo's computed style. Clone only.
 * Test bundle: TODO, add later (icon-via-::before, custom list markers).
 *
 * Why this exists: ::before/::after content (counters, quote glyphs, decorative
 * bars, css icons) and styled ::marker/::placeholder render no dom node, so a
 * clone loses them entirely. Inline styles cannot target a pseudo-element, so the
 * faithful fix is a real css rule. The marker is a data-* attribute (not a class)
 * so it survives the tailwind/bem emitters, which rewrite class but keep data-*.
 */
import type { Captured } from '../../types';
import { pairedSubtrees, isRedundantDecl, transformContext, inheritsProperty } from '../match';
import { pseudoDefaults, effectiveInherited, resolveCssWideKeyword } from '../denoise';

const MARKER = 'data-snip-pseudo';

/**
 * The visual properties snapshotted for a pseudo-element, the bounded css-spec
 * surface that defines a generated box's appearance.
 */
const PSEUDO_PROPS = [
	'content', 'display', 'position', 'top', 'right', 'bottom', 'left',
	'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
	'margin', 'padding', 'color', 'background', 'border', 'border-radius', 'box-shadow',
	'font', 'line-height', 'letter-spacing', 'text-align', 'text-transform', 'text-decoration',
	'white-space', 'opacity', 'transform', 'transform-origin', 'transition', 'z-index',
	'overflow', 'vertical-align', 'list-style-type', '-webkit-text-fill-color', 'background-clip',
];

/**
 * Materializes generated-content pseudo-elements as css rules on the clone.
 *
 * @param captured - clone is mutated in place
 */
export function apply(captured: Captured): Captured {
	const rules: string[] = [];
	let counter = 0;

	for (const [original, clone] of pairedSubtrees(captured.root, captured.clone)) {
		const pseudos = pseudosFor(original);
		const elementRules: string[] = [];
		for (const pseudo of pseudos) {
			const rule = ruleFor(original, clone, pseudo, counter, captured);
			if (rule) elementRules.push(rule);
		}
		if (elementRules.length > 0) {
			clone.setAttribute(MARKER, String(counter));
			rules.push(...elementRules);
			counter++;
		}
	}

	if (rules.length > 0) {
		const style = document.createElement('style');
		style.textContent = rules.join('\n');
		captured.clone.appendChild(style);
	}
	return captured;
}

/** Which pseudo-elements are worth emitting for this element. */
function pseudosFor(el: Element): string[] {
	const out: string[] = [];
	if (hasContent(el, '::before')) out.push('::before');
	if (hasContent(el, '::after')) out.push('::after');
	// A styled list marker only renders on display:list-item (spec mechanism, not a tag check).
	if (getComputedStyle(el).display === 'list-item') out.push('::marker');
	// A placeholder pseudo only exists where a placeholder attribute does.
	if (el.hasAttribute('placeholder')) out.push('::placeholder');
	try {
		if (el.matches('input[type="file"]')) out.push('::file-selector-button');
	} catch {
		// Matches unsupported; ignore.
	}
	return out;
}

/** True when a ::before/::after actually generates a box (content not `none`). */
function hasContent(el: Element, pseudo: string): boolean {
	const content = getComputedStyle(el, pseudo).getPropertyValue('content');
	return content !== '' && content !== 'none' && content !== 'normal';
}

/** Build one `[data-snip-pseudo="n"]pseudo {... }` rule from the live pseudo's computed style. */
function ruleFor(el: Element, clone: Element, pseudo: string, id: number, captured: Captured): string | null {
	const computed = getComputedStyle(el, pseudo);
	// Every pseudo is de-noised against the same ground truth the element pass uses: the
	// ua default for this pseudo on this element (read from a clean iframe probe, so the
	// page's author rules are stripped) is the baseline a non-inherited value falls back
	// to, and the originating element's effective snip value (effectiveInherited, never
	// the live page) is what an inherited value falls back to. This drops the inert pseudo
	// noise (list-style-type: disc, vertical-align: baseline, content: normal on a
	// placeholder) while keeping the real ::placeholder/::marker appearance.
	const defaults = pseudoDefaults(el, pseudo);
	const { hasTransform, hasPerspective } = transformContext(computed);
	// Generated content is load-bearing for the box-generating pseudos and always kept;
	// for ::placeholder/::file-selector-button content is just `normal` noise, so it
	// falls through to the inert-keyword check below and drops.
	const keepContent = pseudo === '::before' || pseudo === '::after' || pseudo === '::marker';

	const decls: string[] = [];
	for (const prop of PSEUDO_PROPS) {
		const value = computed.getPropertyValue(prop);
		if (!value) continue;
		if (prop === 'content' && keepContent) {
			decls.push(`\t${prop}: ${value};`);
			continue;
		}
		// The universally-inert keywords carry no box, spacing, or decoration.
		if (value === 'normal' || value === 'auto' || value === 'none') continue;
		const inherits = inheritsProperty(prop);
		// Resolve a css-wide keyword to the value it produces first, so the same
		// redundancy test sheds keyword-form defaults from the pseudo too.
		const resolved = resolveCssWideKeyword(captured, clone, prop, value) ?? value;
		const redundant = isRedundantDecl(prop, resolved, {
			defaultValue: defaults.get(prop),
			inheritedValue: inherits ? effectiveInherited(captured, clone, prop) : undefined,
			inherits,
			hasTransform,
			hasPerspective,
		});
		if (!redundant) decls.push(`\t${prop}: ${value};`);
	}
	if (decls.length === 0) return null;
	return `[${MARKER}="${id}"]${pseudo} {\n${decls.join('\n')}\n}`;
}
