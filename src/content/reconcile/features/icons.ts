/**
 * features/icons.ts: svg sprite resolution
 *
 * Pipeline position: reconcile
 * Reads from Captured: root, the source document, and clone
 * Writes to Captured: clone, prepending a hidden <defs> sprite, and warnings
 *
 * Principles applied: none directly; a feature handler for the svg <use href>
 * mechanism.
 *
 * CSS/spec reference: https://developer.mozilla.org/en-US/docs/Web/SVG/Element/use
 * Detection criterion: the clone contains at least one <use> with a local
 * #fragment href / xlink:href. Early-return otherwise.
 * Transform contract: reads referenced <symbol>/element ids from the live source
 * document, clones them, and inlines them inside a hidden <svg><defs> at the
 * top of the clone so the <use> refs resolve locally. Modifies clone only;
 * never reads other handlers' fields.
 *
 * Why this exists: design systems store icons as <symbol> definitions in a shared
 * sprite outside the picked subtree. Without resolving them at extraction time,
 * every <use href="#x"> renders as a blank 0x0 box once the snip is pasted
 * elsewhere. currentColor on fill/stroke keeps working because reconcile already
 * baked `color` onto the snip root. Ported and rewritten from v1
 * vision/_archive/context-builder.ts (resolveSvgSprites/collectUseRefs/
 * findSymbolInDocument).
 */
import type { Captured } from '../../types';

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

/**
 * Inlines the <symbol> definitions referenced by <use> elements in the clone.
 *
 * @param captured - clone is mutated in place; returned for the handler chain
 */
export function apply(captured: Captured): Captured {
	const uses = Array.from(captured.clone.querySelectorAll('use'));
	if (uses.length === 0) return captured; // No sprite refs, nothing to do

	const wantedIds = new Set<string>();
	for (const use of uses) {
		const ref = use.getAttribute('href') ?? use.getAttributeNS(XLINK_NS, 'href') ?? use.getAttribute('xlink:href');
		if (ref && ref.startsWith('#')) wantedIds.add(ref.slice(1));
	}
	if (wantedIds.size === 0) return captured; // Only external refs; cannot inline

	const symbols: Element[] = [];
	for (const id of wantedIds) {
		// Symbols are global ids in the live document; getElementById finds them
		// even when they live outside the picked subtree, which is the whole point.
		const found = document.getElementById(id);
		if (found) symbols.push(found.cloneNode(true) as Element);
		else captured.warnings.push(`icons: sprite symbol #${id} not found in document`);
	}
	if (symbols.length === 0) return captured;

	// A single hidden svg carrying the referenced symbols, prepended so the refs
	// resolve before they are used.
	const sprite = document.createElementNS(SVG_NS, 'svg');
	sprite.setAttribute('aria-hidden', 'true');
	sprite.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden');
	const defs = document.createElementNS(SVG_NS, 'defs');
	for (const sym of symbols) defs.appendChild(sym);
	sprite.appendChild(defs);
	captured.clone.insertBefore(sprite, captured.clone.firstChild);

	return captured;
}
