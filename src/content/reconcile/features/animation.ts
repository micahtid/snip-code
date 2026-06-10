/**
 * features/animation.ts: animation, transition, transform context
 *
 * Phase: g (tier 1 feature handlers), see SNIPCODE-REWRITE-PLAN.md section 12
 * Pipeline position: 2, reconcile
 * Reads from Captured: root, clone, bakedStyles
 * Writes to Captured: bakedStyles + clone (transform context + anim declarations)
 *
 * Principles applied: extends P1's "ship what renders" to the transform/animation
 * context, without disturbing P1's own decision about the `transform` value.
 *
 * CSS/spec reference: https://developer.mozilla.org/en-US/docs/Web/CSS/transform
 *   (also animation, transition, perspective, transform-style, backface-visibility)
 * Detection criterion: an element with a non-default value for one of the
 *   transform-context or animation/transition properties. per-element early-return.
 * Transform contract: bakes those computed values onto the matching clone
 *   element. it deliberately does NOT re-bake `transform` / individual
 *   translate/rotate/scale, those can be mid-animation at capture time, and P1
 *   already owns the value. mutates bakedStyles + clone inline styles only.
 * Test bundle: TODO, add in Stage 5 (3d card flip, keyframe loader).
 *
 * Why this exists: the static transform context (transform-origin, perspective,
 * 3d flags) and the animation/transition shorthands are easily omitted from the
 * authored cascade, yet they shape the rendered frame, the grader freezes
 * animations at frame 0 (reducedMotion), so the @keyframes 0% styles only apply
 * if the element still carries its `animation` declaration and the keyframes
 * travel (resolve/anim keeps the referenced ones, with cubic-bezier precision
 * intact in the verbatim keyframe text). `transform` itself is left to P1 so an
 * animated element is not locked to a mid-flight frame that would mismatch
 * frame 0. tier 1 #9.
 */
import type { Captured } from '../../types';
import { pairedSubtrees } from '../match';

/**
 * the transform-context and animation properties this handler preserves, the
 * bounded css-spec surface for animation/3d (a feature-handler spec set, not a
 * decision-layer property Set; section 6). `transform` is intentionally absent.
 */
const ANIM_CONTEXT_PROPS = [
	'transform-origin', 'perspective', 'perspective-origin', 'transform-style', 'backface-visibility',
	'animation', 'transition', 'transition-timing-function', 'animation-timing-function', 'will-change',
];

/** computed values that mean "default" and need no baking. */
function isDefault(prop: string, value: string): boolean {
	const v = value.trim();
	if (v === '' || v === 'none' || v === 'auto' || v === 'normal') return true;
	if (prop === 'perspective' && v === 'none') return true;
	if (prop === 'transform-style' && v === 'flat') return true;
	if (prop === 'backface-visibility' && v === 'visible') return true;
	if (prop === 'will-change' && v === 'auto') return true;
	// a zeroed transition (0s) has no effect at rest.
	if (prop === 'transition' && /^all 0s ease 0s$|^0s\b/.test(v)) return true;
	return false;
}

/**
 * bakes non-default transform-context and animation declarations onto each element.
 *
 * @param captured - bakedStyles + clone are mutated in place
 */
export function apply(captured: Captured): Captured {
	for (const [original, clone] of pairedSubtrees(captured.root, captured.clone)) {
		const computed = getComputedStyle(original);
		const baked = captured.bakedStyles.get(clone) ?? new Map<string, string>();
		for (const prop of ANIM_CONTEXT_PROPS) {
			if (baked.has(prop)) continue;
			const value = computed.getPropertyValue(prop);
			if (isDefault(prop, value)) continue;
			baked.set(prop, value);
			try {
				(clone as HTMLElement).style.setProperty(prop, value);
			} catch {
				// invalid for this element; skip.
			}
		}
		captured.bakedStyles.set(clone, baked);
	}
	return captured;
}
