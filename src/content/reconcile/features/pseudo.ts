/**
 * features/pseudo.ts: generated-content pseudo-elements
 *
 * Phase: g (tier 1 feature handlers), see SNIPCODE-REWRITE-PLAN.md section 12
 * Pipeline position: 2, reconcile
 * Reads from Captured: root, clone
 * Writes to Captured: clone (marks elements + appends a <style> of pseudo rules)
 *
 * Principles applied: extends P1 to pseudo-elements, which inline styles cannot
 * express.
 *
 * CSS/spec reference: https://developer.mozilla.org/en-US/docs/Web/CSS/Pseudo-elements
 * Detection criterion: ::before/::after with computed content other than `none`;
 *   ::marker on display:list-item elements; ::placeholder on elements with a
 *   placeholder attribute; ::file-selector-button on file inputs.
 * Transform contract: tags the matching clone element with a data-snip-ps marker
 *   and appends one <style> to the clone carrying `[data-snip-ps="n"]::x { ... }`
 *   rules snapshotted from the live pseudo's computed style. clone only.
 * Test bundle: TODO, add in Stage 5 (icon-via-::before, custom list markers).
 *
 * Why this exists: ::before/::after content (counters, quote glyphs, decorative
 * bars, css icons) and styled ::marker/::placeholder render no dom node, so a
 * clone loses them entirely. inline styles cannot target a pseudo-element, so the
 * faithful fix is a real css rule. the marker is a data-* attribute (not a class)
 * so it survives the tailwind/bem emitters, which rewrite class but keep data-*.
 */
import type { Captured } from '../../types';
import { pairedSubtrees } from '../match';

const MARKER = 'data-snip-ps';

/**
 * the visual properties snapshotted for a pseudo-element, the bounded css-spec
 * surface that defines a generated box's appearance (a feature-handler spec set,
 * not a decision-layer property Set; section 6).
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
 * materializes generated-content pseudo-elements as css rules on the clone.
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
			const rule = ruleFor(original, pseudo, counter);
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

/** which pseudo-elements are worth emitting for this element. */
function pseudosFor(el: Element): string[] {
	const out: string[] = [];
	if (hasContent(el, '::before')) out.push('::before');
	if (hasContent(el, '::after')) out.push('::after');
	// a styled list marker only renders on display:list-item (spec mechanism, not a tag check).
	if (getComputedStyle(el).display === 'list-item') out.push('::marker');
	// a placeholder pseudo only exists where a placeholder attribute does.
	if (el.hasAttribute('placeholder')) out.push('::placeholder');
	try {
		if (el.matches('input[type="file"]')) out.push('::file-selector-button');
	} catch {
		// matches unsupported; ignore.
	}
	return out;
}

/** true when a ::before/::after actually generates a box (content not `none`). */
function hasContent(el: Element, pseudo: string): boolean {
	const content = getComputedStyle(el, pseudo).getPropertyValue('content');
	return content !== '' && content !== 'none' && content !== 'normal';
}

/** build one `[data-snip-ps="n"]pseudo { ... }` rule from the live pseudo's computed style. */
function ruleFor(el: Element, pseudo: string, id: number): string | null {
	const computed = getComputedStyle(el, pseudo);
	const decls: string[] = [];
	for (const prop of PSEUDO_PROPS) {
		const value = computed.getPropertyValue(prop);
		if (value && value !== 'normal' && value !== 'auto' && value !== 'none' || prop === 'content') {
			if (value) decls.push(`\t${prop}: ${value};`);
		}
	}
	if (decls.length === 0) return null;
	return `[${MARKER}="${id}"]${pseudo} {\n${decls.join('\n')}\n}`;
}
