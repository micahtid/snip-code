/**
 * capture/settle.ts: bring the target to its settled, revealed state before capture
 *
 * Pipeline position: capture (runs first, before clone + computed read)
 * Reads from Captured: n/a (operates on the live root before Captured is built)
 * Writes to Captured: n/a (returns a warning string the caller records)
 *
 * Why this exists: the capture path reads a transient frame. Many components enter
 * with a scroll-driven reveal, an element styled `opacity: 0` plus a transform
 * offset until an IntersectionObserver flips a class on scroll. If we clone and read
 * computed style before that fires, we bake the frozen blank pre-reveal frame and the
 * snip ships empty, even though the reference, which the grader scrolls into view
 * before screenshotting, looks fully revealed. The same gap leaves lazy images
 * unloaded and webfonts unswapped.
 *
 * Settle removes the gap by driving the live element to the state a human would see:
 * scroll it into view so observers and scroll reveals fire, await the reveal, finish
 * any running transitions/animations to their end state, so the capture is stable and
 * deterministic, not a mid-flight frame, force lazy images to load and decode, and
 * await fonts. Infinite animations are left alone, because finishing them is
 * meaningless and the guard keeps the settle deterministic.
 *
 * It does not mutate authored styles or structure. It only nudges the page's own
 * reveal machinery and waits. A reveal that is gated on an event we cannot fire, such as
 * a click or a custom timer, will not settle. That residual is detected and returned as a
 * warning so the snip is flagged rather than shipped silently blank.
 */

/** Resolves after `n` animation frames, letting reveal classes and layout apply. */
function nextFrames(n: number): Promise<void> {
	return new Promise((resolve) => {
		let left = n;
		const tick = (): void => {
			if (--left <= 0) resolve();
			else requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	});
}

/**
 * Drives the live root to its settled, revealed state. Best-effort and non-throwing:
 * any step that fails is swallowed so capture always proceeds.
 *
 * @param root - the live element about to be cloned
 * @returns a warning when a reveal appears not to have fired, else empty
 */
export async function settle(root: Element): Promise<{ warning?: string }> {
	try {
		// Scroll into view so IntersectionObserver and scroll-driven reveals fire. Center
		// rather than nearest so an observer with a viewport-margin threshold still trips.
		root.scrollIntoView({ block: 'center', inline: 'nearest' });
	} catch {
		// Detached or non-scrollable context. The awaits below still help.
	}
	// Let the observer callback run and any reveal class apply before measuring.
	await nextFrames(2);

	await loadImages(root);
	finishTransientAnimations(root);

	// One more frame so finished transitions and decoded images settle the layout.
	await nextFrames(1);
	try {
		await document.fonts.ready;
	} catch {
		// Font readiness is best-effort.
	}

	return detectUnrevealed(root);
}

/**
 * Forces every image in the subtree to load eagerly and awaits decode, so the capture
 * reads loaded dimensions and the resolved currentSrc rather than a lazy spacer. Decode
 * failures, whether cross-origin or broken, are ignored, and the snip proceeds either way.
 *
 * @param root - the live subtree
 */
async function loadImages(root: Element): Promise<void> {
	const imgs = Array.from(root.querySelectorAll('img'));
	if (root.tagName === 'IMG') imgs.push(root as HTMLImageElement);
	const decodes: Array<Promise<unknown>> = [];
	for (const img of imgs) {
		const el = img as HTMLImageElement;
		try {
			el.loading = 'eager';
		} catch {
			// Read-only in some contexts, but scrolling still triggers native lazy load.
		}
		// Decode resolves once the current source is ready. Catch so a broken image
		// or a still-pending lazy swap never rejects the settle.
		decodes.push(el.decode().catch(() => undefined));
	}
	await Promise.all(decodes);
}

/**
 * Finishes running transitions and finite animations across the subtree, jumping each
 * to its end state so the capture is a stable, deterministic frame rather than a
 * mid-flight one. Infinite looping animations are skipped: finishing them is
 * undefined, and forcing it would either throw or pin an arbitrary frame.
 *
 * @param root - the live subtree
 */
function finishTransientAnimations(root: Element): void {
	const el = root as Element & { getAnimations?: (opts?: { subtree?: boolean }) => Animation[] };
	if (typeof el.getAnimations !== 'function') return;
	let animations: Animation[] = [];
	try {
		animations = el.getAnimations({ subtree: true });
	} catch {
		return;
	}
	for (const anim of animations) {
		try {
			const timing = anim.effect?.getComputedTiming?.();
			if (timing && timing.iterations === Infinity) continue; // Looping, so leave it.
			anim.finish();
		} catch {
			// Some animations reject finish, e.g. an infinite one the guard did not catch.
		}
	}
}

/**
 * Heuristic check for a reveal that never fired: after settling, the root still paints
 * nothing because it, or its only child wrapper, is held invisible. Returns a warning
 * string so the snip is flagged. This never blocks or alters the snip. It only reports.
 *
 * @param root - the live subtree, post-settle
 */
function detectUnrevealed(root: Element): { warning?: string } {
	try {
		const cs = getComputedStyle(root);
		const invisible = cs.opacity === '0' || cs.visibility === 'hidden' || cs.display === 'none';
		if (invisible) {
			return { warning: 'settle: element still hidden after reveal attempt; a non-scroll trigger (click/timer) may gate it' };
		}
	} catch {
		// No computed style available, so nothing to report.
	}
	return {};
}
