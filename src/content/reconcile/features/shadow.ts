/**
 * features/shadow.ts: shadow dom flattening
 *
 * Pipeline position: reconcile
 * Reads from Captured: root, clone, inaccessible.closedShadowRoots
 * Writes to Captured: clone, flattening open shadow trees + styles, and warnings
 *
 * A feature handler for the shadow dom encapsulation mechanism.
 *
 * CSS/spec reference: https://developer.mozilla.org/en-US/docs/Web/API/Web_components/Using_shadow_DOM
 * Detection criterion: an element in the subtree exposing an open shadowRoot.
 * Early-returns when none do.
 * Transform contract: for each open shadow host, inlines the shadow's
 * adoptedStyleSheets + <style> css as a <style>, with :host rescoped to a data-*
 * marker on the clone host, and appends a clone of the shadow tree to the clone
 * host so its rendered markup travels. Closed roots cannot be read from a content
 * script, only counted via cdp pierce at capture, and are surfaced as a warning.
 * Mutates clone only.
 *
 * Why this exists: cloneNode(true) does not copy shadow roots, so a web
 * component's entire rendered content and its scoped styles vanish from the clone.
 * Flattening the open shadow tree into light dom, with styles rescoped, keeps the
 * component visible standalone. Slot distribution is approximated: shadow content
 * is appended after the host's light children; ::part/::slotted styles are
 * carried verbatim. Shadow content is appended last so match.pairedSubtrees keeps
 * the light-dom pairing aligned for downstream handlers.
 */
import type { Captured } from '../../types';
import { pairedSubtrees } from '../match';

/**
 * Flattens open shadow trees and their scoped styles into the clone.
 *
 * @param captured - clone is mutated in place
 */
export function apply(captured: Captured): Captured {
	let hostId = 0;
	let sawShadow = false;

	for (const [original, clone] of pairedSubtrees(captured.root, captured.clone)) {
		const shadow = (original as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
		if (!shadow) continue; // No open shadow root; closed roots read as null here
		sawShadow = true;

		const id = hostId++;
		clone.setAttribute('data-snip-host', String(id));
		const css = collectShadowCss(shadow);
		if (css) {
			const style = document.createElement('style');
			// Rescope :host to the host marker so the styles apply in light dom.
			style.textContent = css.replace(/:host(\([^)]*\))?/g, `[data-snip-host="${id}"]`);
			clone.appendChild(style);
		}
		// Append the rendered shadow markup after the host's light children.
		for (const child of Array.from(shadow.children)) {
			clone.appendChild(child.cloneNode(true));
		}
	}

	if (!sawShadow && captured.inaccessible.closedShadowRoots > 0) {
		captured.warnings.push(`shadow: ${captured.inaccessible.closedShadowRoots} closed shadow root(s) could not be flattened`);
	}
	return captured;
}

/** Concatenate a shadow root's adopted + inline stylesheet css. */
function collectShadowCss(shadow: ShadowRoot): string {
	const parts: string[] = [];
	// Constructable stylesheets attached via adoptedStyleSheets.
	for (const sheet of shadow.adoptedStyleSheets ?? []) {
		try {
			for (const rule of Array.from(sheet.cssRules)) parts.push(rule.cssText);
		} catch {
			// Cross-origin constructable sheet, rare; skip.
		}
	}
	// Inline <style> blocks inside the shadow root.
	for (const styleEl of Array.from(shadow.querySelectorAll('style'))) {
		if (styleEl.textContent) parts.push(styleEl.textContent);
	}
	return parts.join('\n');
}
