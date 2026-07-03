/**
 * polish/verify.ts: render-neutrality check for the llm polish edits
 *
 * Pipeline position: polish
 * Reads from Captured: page.viewport, to size the frames
 * Writes to Captured: nothing; operates on the pre- and post-polish html + css
 *
 * Why this exists: the polish pass takes edits from the user's own model, semantic class
 * renames, semantic tag swaps, and grouping comments, all meant to be render-neutral. A
 * model can still get one wrong, renaming a class inconsistently or swapping a tag whose ua
 * styles differ. This confirms the polished artifact renders identically to the pre-polish
 * one before it ships, so a bad edit falls back to the deterministic output rather than
 * degrading fidelity.
 *
 * The polish edits never add or remove elements, only rename classes, swap tag names, and
 * add comments, so the two element trees are structurally identical and a lockstep walk
 * pairs them by position. Each pair's full computed style is compared in the isolated
 * pasted-snip environment both artifacts ship into; equal computed styles on the paired
 * dom imply an identical render.
 */
import type { Captured } from '../types';
import { createSizedFrame } from '../reconcile/standalone';

/**
 * Whether the polished artifact renders identically to the pre-polish one. Mounts each in
 * its own isolated, viewport-sized frame, pairs their elements by lockstep position, and
 * requires every paired element's computed style, and its ::before/::after, to match. Any
 * frame or infrastructure failure returns false, so the caller keeps the safe pre-polish
 * output rather than trusting an unverifiable edit.
 *
 * @param captured - source of the viewport size
 * @param preHtml - the pre-polish document markup
 * @param preCss - the pre-polish stylesheet
 * @param postHtml - the polished document markup
 * @param postCss - the polished stylesheet
 */
export function polishRenderNeutral(captured: Captured, preHtml: string, preCss: string, postHtml: string, postCss: string): boolean {
	let pre: Mounted | null = null;
	let post: Mounted | null = null;
	try {
		pre = mount(captured, preHtml, preCss);
		post = mount(captured, postHtml, postCss);
		const preEls = Array.from(pre.body.querySelectorAll('*'));
		const postEls = Array.from(post.body.querySelectorAll('*'));
		if (preEls.length !== postEls.length) return false; // A structural edit; not render-neutral.
		const props = masterProps(pre.win, preEls[0]);
		for (let i = 0; i < preEls.length; i++) {
			if (!elementsMatch(pre.win, preEls[i]!, post.win, postEls[i]!, props)) return false;
		}
		return true;
	} catch {
		return false;
	} finally {
		pre?.frame.remove();
		post?.frame.remove();
	}
}

/** A mounted document: the frame to tear down, its window, and its body. */
interface Mounted {
	frame: HTMLIFrameElement;
	win: Window;
	body: Element;
}

/** Mounts markup + css in a fresh standards-mode frame, returning its window and body. */
function mount(captured: Captured, html: string, css: string): Mounted {
	const sized = createSizedFrame(captured, true);
	const body = bodyOf(html);
	const styleEl = sized.doc.createElement('style');
	styleEl.textContent = css;
	sized.doc.head.appendChild(styleEl);
	sized.doc.body.innerHTML = body;
	return { frame: sized.frame, win: sized.win, body: sized.doc.body };
}

/** The body inner html of a full document string, or the string itself when it has no body. */
function bodyOf(html: string): string {
	const match = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
	return match ? match[1]! : html;
}

/** The enumerable computed longhands of one element, read once and shared across pairs. */
function masterProps(win: Window, el: Element | undefined): string[] {
	const out: string[] = [];
	if (!el) return out;
	const cs = win.getComputedStyle(el);
	for (let i = 0; i < cs.length; i++) {
		const prop = cs.item(i);
		if (prop) out.push(prop);
	}
	return out;
}

/** Whether two paired elements, and their generated pseudo boxes, have identical computed styles. */
function elementsMatch(preWin: Window, preEl: Element, postWin: Window, postEl: Element, props: string[]): boolean {
	for (const pseudo of ['', '::before', '::after']) {
		const a = preWin.getComputedStyle(preEl, pseudo || undefined);
		const b = postWin.getComputedStyle(postEl, pseudo || undefined);
		for (const prop of props) {
			if (a.getPropertyValue(prop) !== b.getPropertyValue(prop)) return false;
		}
	}
	return true;
}
