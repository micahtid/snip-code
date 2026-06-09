/**
 * resolve/anim.ts — @keyframes resolution
 *
 * Phase: d (resolve) — see SNIPCODE-REWRITE-PLAN.md section 12
 * Pipeline position: 3 — resolve
 * Reads from Captured: bakedStyles, keyframes
 * Writes to Captured: keyframes (narrowed to referenced animations)
 *
 * Principles applied: supports P5-aligned "travel with the snip" thinking — a
 * @keyframes block travels only if an animation in the snip references it.
 *
 * Why this exists: animation/transition values are already baked onto elements by
 * P1, but the @keyframes blocks they name live in stylesheets that do not travel.
 * this pairs the animation references in the baked styles with the captured
 * @keyframes and keeps only the ones actually used, so the emitted css carries
 * the animations the snip needs and nothing else. (clean.ts re-checks this as
 * dead-code elimination under P5; here it is the resolve-phase pairing.)
 */
import type { Captured } from '../types';

/**
 * narrows captured @keyframes to those named by an animation in the baked styles.
 *
 * @param captured — keyframes is replaced in place with the referenced subset
 */
export function resolveAnimations(captured: Captured): void {
	if (captured.keyframes.length === 0) return;
	const referenced = referencedAnimationNames(captured);
	captured.keyframes = captured.keyframes.filter((kf) => referenced.has(kf.name));
}

/**
 * collects every token that appears in an animation / animation-name value across
 * the baked styles. the animation shorthand lists name, duration, timing, etc. in
 * any order, so rather than parse the grammar we gather all tokens and let the
 * keyframe-name intersection (in the caller) pick the real names — a duration like
 * "2s" can never collide with a keyframe identifier.
 */
function referencedAnimationNames(captured: Captured): Set<string> {
	const tokens = new Set<string>();
	for (const [, baked] of captured.bakedStyles) {
		for (const prop of ['animation', 'animation-name']) {
			const value = baked.get(prop);
			if (!value) continue;
			for (const part of value.split(',')) {
				for (const token of part.trim().split(/\s+/)) {
					const t = token.trim();
					if (t) tokens.add(t);
				}
			}
		}
	}
	return tokens;
}
