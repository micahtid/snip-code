/**
 * reconcile/denoise.ts: inert-declaration removal
 *
 * Pipeline position: reconcile
 * Reads from Captured: root, clone, bakedStyles
 * Writes to Captured: bakedStyles and clone, removing redundant inline styles, plus warnings
 *
 * Removal is render-identical by construction, never aesthetic surgery.
 *
 * Why this exists: bake.ts and the feature handlers bake every winning property
 * onto each element, including many that merely restate a default (animation-
 * timing-function: ease, vertical-align: baseline), have no effect in context,
 * such as transform-origin with no transform, or just repeat an inherited value. The
 * result renders correctly but reads as noise. This step drops those declarations
 * against ground truth: a per-tag ua default read from a clean probe element, what
 * a non-inherited property falls back to, and the immediate parent's computed value,
 * what an inherited property falls back to. It runs on bakedStyles before convert,
 * so every output format ships the smaller result and the polish llm sees clean
 * markup.
 *
 * Two further drops ride the same ground-truth machinery. A css-wide keyword
 * (initial/inherit/unset) reaches the output verbatim because bake.ts prefers the
 * authored value when it round-trips; resolveCssWideKeyword resolves it to the value
 * it actually produces so isRedundantDecl can match it against the fallback and drop
 * it when inert. And a legacy vendor-prefixed flexbox longhand such as -webkit-box-align
 * and friends is dropped when its standard counterpart is present and the legacy box model
 * is not in use, since every engine then ignores the prefixed form.
 *
 * Like bake.ts, it trusts no hand-curated "is this noise" Set: the decision lives in
 * match.ts's isRedundantDecl, which only ever removes a measured no-op. The probe is
 * off-screen and laid out, not display:none and not detached, because getComputedStyle
 * returns empty or blockified values otherwise.
 */
import type { Captured } from '../types';
import { pairedSubtrees, isRedundantDecl, transformContext, inheritsProperty } from './match';

/**
 * De-noises every baked element by dropping declarations that render identically
 * when removed.
 *
 * @param captured - bakedStyles + clone are mutated in place
 */
export function denoise(captured: Captured): void {
	try {
		const pairs = pairedSubtrees(captured.root, captured.clone);
		withProbeFrame((doc, win) => {
			const defaultsFor = elementDefaultProbe(doc, win);
			for (let i = 0; i < pairs.length; i++) {
				const pair = pairs[i];
				if (!pair) continue;
				const [original, clone] = pair;
				const baked = captured.bakedStyles.get(clone);
				if (!baked || baked.size === 0) continue;

				const isRoot = i === 0;
				const defaults = defaultsFor(original);
				const { hasTransform, hasPerspective } = transformContext(getComputedStyle(original));

				for (const [prop, value] of Array.from(baked)) {
					const inherits = inheritsProperty(prop);
					// The snip root loses its ancestor chain, so an inherited value baked
					// onto it by bake.ts's inherited-divergence pass has no parent to fall
					// back to and must stay. Non-inherited values on the root are still
					// de-noised: their default is parent-independent.
					if (isRoot && inherits) continue;
					// A css-wide keyword is resolved to the value it produces before the
					// comparison, so isRedundantDecl can match it against the fallback;
					// non-keyword values pass through untouched.
					const resolved = resolveCssWideKeyword(captured, clone, prop, value) ?? value;
					const redundant = isRedundantDecl(prop, resolved, {
						defaultValue: defaults.get(prop),
						inheritedValue: inherits ? effectiveInherited(captured, clone, prop) : undefined,
						inherits,
						hasTransform,
						hasPerspective,
					});
					if (redundant) dropDecl(baked, clone, prop);
				}
				dropDeadPrefixes(captured, baked, clone);
				if (baked.size === 0) captured.bakedStyles.delete(clone);
			}
		});
	} catch (err) {
		captured.warnings.push(`denoise: skipped (${(err as Error).message})`);
	}
}

/**
 * Removes one declaration from both the baked map and the clone's inline style. The
 * inline removal can throw for a property this element rejects, in which case the
 * baked-map delete alone is enough.
 *
 * @param baked - the element's baked declaration map
 * @param clone - the clone element whose inline style mirrors the baked map
 * @param prop - the property to drop
 */
function dropDecl(baked: Map<string, string>, clone: Element, prop: string): void {
	baked.delete(prop);
	try {
		(clone as HTMLElement).style.removeProperty(prop);
	} catch {
		// Not removable for this element; the baked-map delete is enough.
	}
}

/**
 * Resolves a css-wide keyword (initial/inherit/unset) to the concrete value it
 * produces, so the redundancy test can compare it against the value the element falls
 * back to. bake.ts ships these keywords verbatim when they round-trip the computed
 * value, and isRedundantDecl is an exact-string test, so `initial` never matches a
 * resolved default like `rgb(0, 0, 0)`. Resolving first lets the existing predicate
 * drop the keyword wherever the value it produces equals the fallback, with no new
 * comparison logic.
 *
 * `initial` resolves to the spec initial value, from the all:initial probe, deliberately
 * not the ua default since the two differ for e.g. display. `inherit` resolves to
 * the element's effective inherited value, but only for a property that actually
 * inherits: on a non-inherited property, box-sizing being the common one via the
 * `* { box-sizing: inherit }` idiom, `inherit` pulls the parent's used value, which the
 * baked chain does not carry, so it is left untouched rather than mis-resolved to the
 * initial and wrongly dropped. `unset` resolves to the inherited value for an inherited
 * property, else the spec initial, matching the spec definition, where it is identical
 * to `initial` and never the parent's value, so it is always safe to resolve. `revert` is
 * left untouched: it reverts to the ua/author origin, which the standalone snip does
 * not carry, so it is never provably inert.
 *
 * @param captured - source of the per-clone baked maps, for inherited resolution
 * @param clone - the element whose declaration is under test
 * @param prop - the property name
 * @param value - the declared value
 * @returns the resolved value, or undefined to leave the value untouched
 */
export function resolveCssWideKeyword(captured: Captured, clone: Element, prop: string, value: string): string | undefined {
	switch (value.trim()) {
		case 'initial':
			return initialStyles().get(prop);
		case 'inherit':
			return inheritsProperty(prop) ? effectiveInherited(captured, clone, prop) : undefined;
		case 'unset':
			return inheritsProperty(prop) ? effectiveInherited(captured, clone, prop) : initialStyles().get(prop);
		default:
			return undefined;
	}
}

/**
 * Drops legacy vendor-prefixed flexbox longhands whose standard counterpart is present
 * on the same element. A prefixed property is honored only when its old display model
 * is actually in use, so when the modern standard property sits beside it AND that old
 * model is not active, every engine ignores the prefixed form, making its removal a
 * provable no-op. A prefixed property with no standard sibling is never dropped: there
 * it could still be load-bearing.
 *
 * The display guard is load-bearing, not belt-and-suspenders: under `display:
 * -webkit-box`/`-webkit-inline-box` the old box model is live, so `-webkit-box-orient:
 * vertical`, the `-webkit-line-clamp` multi-line-ellipsis idiom, and its siblings still
 * drive layout even with a standard property present. It is checked against the BAKED
 * display, not the live computed display: the output renders with the baked value, so
 * that is the value that decides whether the prefixed prop is load-bearing, and live
 * getComputedStyle is unreliable here anyway, since a -webkit-box element with line-clamp
 * reports `flow-root`. The old box props are honored on the element itself
 * (orient/direction/align/pack) or on a child of an old box (flex/ordinal-group), so the
 * guard checks the element's own baked display and its parent's. The
 * `-webkit-flex-*`/`-webkit-align-*` aliases need no guard: modern engines treat them as
 * plain aliases of the standard names, so the standard sibling wins regardless.
 *
 * @param captured - source of the per-clone baked maps, for the parent display check
 * @param baked - the element's baked declaration map
 * @param clone - the clone element whose inline style mirrors the baked map
 */
function dropDeadPrefixes(captured: Captured, baked: Map<string, string>, clone: Element): void {
	const selfOldBox = isOldBox(baked.get('display'));
	let parentOldBox: boolean | undefined;
	for (const [prefixed, standard, scope] of PREFIXED_FLEX_PAIRS) {
		if (!baked.has(prefixed) || !baked.has(standard)) continue;
		if (scope === 'box-self' && selfOldBox) continue;
		if (scope === 'box-item') {
			// Resolved lazily: most elements carry no old box item property at all.
			if (parentOldBox === undefined) {
				const parent = clone.parentElement;
				parentOldBox = isOldBox(parent ? captured.bakedStyles.get(parent)?.get('display') : undefined);
			}
			if (parentOldBox) continue;
		}
		dropDecl(baked, clone, prefixed);
	}
}

/** Whether a baked display uses the legacy 2009 flexbox (`-webkit-box`) model. */
function isOldBox(display: string | undefined): boolean {
	return display === '-webkit-box' || display === '-webkit-inline-box';
}

/**
 * The value `prop` actually inherits in the standalone snip: the nearest clone
 * ancestor that bakes it, or the css initial value. This is what the element falls
 * back to when its own declaration is dropped, read deliberately from the baked
 * clone chain rather than the live page. A value the live ancestor only inherits
 * from the page, a global body font say, does not travel with the snip, so
 * comparing against the live parent would drop a declaration the snip still needs.
 *
 * @param captured - source of the per-clone baked maps
 * @param clone - the element whose inherited fallback is wanted
 * @param prop - the inherited property
 * @returns the inherited value, or undefined if not even an initial exists
 */
export function effectiveInherited(captured: Captured, clone: Element, prop: string): string | undefined {
	let node = clone.parentElement;
	while (node) {
		const value = captured.bakedStyles.get(node)?.get(prop);
		if (value !== undefined) return value;
		node = node.parentElement;
	}
	return initialStyles().get(prop);
}

/**
 * Builds a probe that returns an element's ua default computed style: a shallow copy
 * of the element, its attributes minus the style attribute, laid out alone in the
 * hidden iframe. The default a standalone snip falls back to depends on the element's
 * attributes, not just its tag: `a[href]` is underlined, `a` without href is not;
 * `input[type=checkbox]` differs from a text input. The shallow copy captures those
 * attributes, while the iframe strips the page's own author rules, which do not travel
 * with the snip. Results are cached per attribute signature for the snip.
 *
 * @param doc - the probe iframe document
 * @param win - the probe iframe window (its getComputedStyle)
 * @returns a function from a live element to its longhand prop->default-value map
 */
function elementDefaultProbe(doc: Document, win: Window): (el: Element) => Map<string, string> {
	const cache = new Map<string, Map<string, string>>();
	return (el: Element): Map<string, string> => {
		const key = probeKey(el);
		let defaults = cache.get(key);
		if (!defaults) {
			const probe = doc.importNode(el, false) as Element;
			probe.removeAttribute('style');
			doc.body.appendChild(probe);
			defaults = snapshotLonghands(win.getComputedStyle(probe));
			probe.remove();
			cache.set(key, defaults);
		}
		return defaults;
	};
}

/**
 * A cache key over the attributes that affect an element's ua styling. Excludes style,
 * the thing under test, plus id, class, and the data- and aria- families, which
 * never match a ua rule, so folding them in would only fragment the cache.
 *
 * @param el - the element to key
 */
function probeKey(el: Element): string {
	const parts = [el.tagName.toLowerCase()];
	for (const attr of Array.from(el.attributes)) {
		const name = attr.name;
		if (name === 'style' || name === 'id' || name === 'class') continue;
		if (name.startsWith('data-') || name.startsWith('aria-')) continue;
		parts.push(`${name}=${attr.value}`);
	}
	return parts.join('|');
}

/**
 * The ua default computed style for a pseudo-element on a given element: a shallow
 * copy of the element laid out alone in the hidden iframe, read at `pseudo`. This is
 * the real ua default for that pseudo on that element, such as ::placeholder's grey
 * color or ::marker's disc, the baseline a non-inherited pseudo declaration falls back to.
 * Like elementDefaultProbe it strips the page's author rules, which do not travel
 * with the snip, so the pseudo handler can de-noise against the same ground truth
 * the element pass uses. Cached per attribute signature + pseudo for the snip.
 *
 * @param el - the originating element
 * @param pseudo - the pseudo-element selector, e.g. '::placeholder'
 * @returns a longhand prop->default-value map for that pseudo
 */
export function pseudoDefaults(el: Element, pseudo: string): Map<string, string> {
	const key = `${probeKey(el)}${pseudo}`;
	const cached = PSEUDO_DEFAULT_CACHE.get(key);
	if (cached) return cached;
	let defaults = new Map<string, string>();
	withProbeFrame((doc, win) => {
		const probe = doc.importNode(el, false) as Element;
		probe.removeAttribute('style');
		doc.body.appendChild(probe);
		defaults = snapshotLonghands(win.getComputedStyle(probe, pseudo));
		probe.remove();
	});
	PSEUDO_DEFAULT_CACHE.set(key, defaults);
	return defaults;
}

/**
 * Reads the css initial value of every longhand, from a single all:initial probe in
 * the hidden iframe. Cached, since initials are constant. Used as the last-resort
 * inherited fallback when no clone ancestor bakes a property.
 *
 * @returns a longhand prop->initial-value map
 */
function initialStyles(): Map<string, string> {
	if (!INITIAL_CACHE) {
		withProbeFrame((doc, win) => {
			const probe = doc.createElement('div');
			probe.style.cssText = 'all:initial';
			doc.body.appendChild(probe);
			INITIAL_CACHE = snapshotLonghands(win.getComputedStyle(probe));
			probe.remove();
		});
	}
	return INITIAL_CACHE ?? new Map<string, string>();
}

/**
 * Runs `fn` against a fresh, hidden, same-origin iframe, where about:blank carries only the
 * ua stylesheet, isolated from the page's author rules, tearing it down afterward.
 *
 * @param fn - reads probe styles from the iframe document/window while it is attached
 */
function withProbeFrame(fn: (doc: Document, win: Window) => void): void {
	const frame = document.createElement('iframe');
	frame.setAttribute('aria-hidden', 'true');
	frame.style.cssText = 'position:absolute;left:-99999px;top:0;width:0;height:0;border:0;visibility:hidden';
	document.body.appendChild(frame);
	try {
		const doc = frame.contentDocument;
		const win = frame.contentWindow;
		if (!doc || !win) throw new Error('probe iframe unavailable');
		fn(doc, win as unknown as Window);
	} finally {
		frame.remove();
	}
}

/** Snapshot every enumerable longhand from a computed style into a plain map. */
function snapshotLonghands(cs: CSSStyleDeclaration): Map<string, string> {
	const map = new Map<string, string>();
	for (let i = 0; i < cs.length; i++) {
		const prop = cs.item(i);
		if (prop) map.set(prop, cs.getPropertyValue(prop));
	}
	return map;
}

let INITIAL_CACHE: Map<string, string> | null = null;
const PSEUDO_DEFAULT_CACHE = new Map<string, Map<string, string>>();

/**
 * How a prefixed flexbox property is honored, which decides its display guard:
 * `box-self` is a 2009 box property honored on its own `-webkit-box` element
 * (orient/direction/align/pack), `box-item` one honored on a child of a `-webkit-box`
 * (flex/ordinal-group), and `alias` a 2011 `-webkit-flex-*`/`-webkit-align-*` name that
 * modern engines treat as a plain alias of the standard property, needing no guard.
 */
type PrefixScope = 'box-self' | 'box-item' | 'alias';

/**
 * Legacy vendor-prefixed flexbox longhands paired with the standard property that
 * supersedes them and the scope that decides their display guard: the 2009
 * `-webkit-box-*` syntax and the 2011 `-webkit-flex-*` aliases. A prefixed property is
 * dropped only when its standard counterpart is present and its old display model is
 * not active; see dropDeadPrefixes. Value equivalence is irrelevant: the gate is the
 * standard sibling plus the display guard, never a value match.
 */
const PREFIXED_FLEX_PAIRS: Array<[string, string, PrefixScope]> = [
	['-webkit-box-align', 'align-items', 'box-self'],
	['-webkit-box-pack', 'justify-content', 'box-self'],
	['-webkit-box-orient', 'flex-direction', 'box-self'],
	['-webkit-box-direction', 'flex-direction', 'box-self'],
	['-webkit-box-flex', 'flex-grow', 'box-item'],
	['-webkit-box-ordinal-group', 'order', 'box-item'],
	['-webkit-flex-direction', 'flex-direction', 'alias'],
	['-webkit-flex-wrap', 'flex-wrap', 'alias'],
	['-webkit-flex-flow', 'flex-flow', 'alias'],
	['-webkit-flex-grow', 'flex-grow', 'alias'],
	['-webkit-flex-shrink', 'flex-shrink', 'alias'],
	['-webkit-flex-basis', 'flex-basis', 'alias'],
	['-webkit-justify-content', 'justify-content', 'alias'],
	['-webkit-align-items', 'align-items', 'alias'],
	['-webkit-align-self', 'align-self', 'alias'],
	['-webkit-align-content', 'align-content', 'alias'],
	['-webkit-order', 'order', 'alias'],
];
