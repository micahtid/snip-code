/**
 * minimize/reset.ts: inject the canonical reset preamble
 *
 * Pipeline position: minimize, after var inlining and before the closing prune rerun
 * Reads from Captured: page.viewport via the oracle; warnings on graceful skip
 * Writes to Captured: nothing; transforms the stylesheet string
 *
 * Why this exists: the reproduce phase bakes `box-sizing: border-box` onto every rule,
 * restates the inherited font on every control, and repeats the same link, list, and button
 * zeroing on element after element, because it copies each element's full computed style. A
 * human writes the lines everyone knows once, at the top, and lets the cascade carry them.
 * This injects that canonical reset, then the prune rerun that follows deletes the per-rule
 * restatements the reset now makes redundant, so `box-sizing` and `cursor: pointer` appear
 * once instead of on hundreds of rules.
 *
 * Each reset line is an addition candidate, the reverse of prune's deletion: it is inserted
 * at the top of the sheet and kept only when the computed-style oracle confirms it changed no
 * element's render. A low-specificity selector, `*` or a bare element, is overridden by any
 * real rule, so a sheet that already computes the reset value everywhere is unchanged by the
 * line and accepts it, while a deviant element keeps its own rule and vetoes nothing. A line
 * the oracle rejects is simply not injected. Because the oracle compares every computed
 * longhand, a non-painting line like `cursor: pointer` is verified exactly like a painting one,
 * and a restatement is only pruned once the preamble supplies the identical computed value.
 * Lines stay fine grained, one property to a line, because acceptance is all or nothing per
 * line: one deviant element would veto a whole coarse line and lose the rest with it.
 */
import type { Captured } from '../types';
import { withOracle, type RenderOracle } from './oracle';
import { serializeRules } from './declarations';

/**
 * The canonical minimal reset, each line a widely known human idiom kept fine grained so a
 * deviant element vetoes only its own line. Injected one at a time and kept only when
 * render-neutral, so the output never gains a rule that shifts it.
 */
const RESET_RULES = [
	'*, *::before, *::after { box-sizing: border-box; }',
	'button, input, select, textarea { font: inherit; color: inherit; }',
	'a { color: inherit; }',
	'a { text-decoration: none; }',
	'a { cursor: pointer; }',
	'button { cursor: pointer; }',
	'button { background: none; }',
	'button { border: none; }',
	'button { padding: 0; }',
	'ul, ol { list-style: none; }',
	'ul, ol { margin: 0; }',
	'ul, ol { padding: 0; }',
];

/**
 * Injects the canonical reset lines the oracle confirms are render-neutral at the top of the
 * sheet. Graceful by contract: returns the input unchanged on any infrastructure failure.
 * Deterministic: the reset lines are tried in a fixed order. The redundant per-rule
 * restatements this makes removable are dropped by the prune pass that runs after it.
 *
 * @param css - the stylesheet after var inlining
 * @param captured - source of the viewport size; warnings are appended here on skip
 * @param markup - the emitted root markup the stylesheet targets, mounted in the oracle
 * @returns the stylesheet with the accepted reset lines prepended, or the input unchanged
 */
export async function injectReset(css: string, captured: Captured, markup: string): Promise<string> {
	return withOracle(css, captured, markup, 'minimize: reset skipped', (oracle) => {
		oracle.captureReference();
		let injected = 0;
		for (const rule of RESET_RULES) {
			try {
				oracle.sheet.insertRule(rule, injected); // Keep accepted resets first, in order.
			} catch {
				continue; // Unparseable in this engine; skip it.
			}
			if (renderNeutral(oracle, rule)) injected++;
			else oracle.sheet.deleteRule(injected); // Not neutral here; do not inject.
		}
		if (injected === 0) return css;
		return serializeRules(Array.from(oracle.sheet.cssRules));
	});
}

/**
 * Whether an injected reset line left the render unchanged. An element-scoped line, `a` or
 * `button`, can change only the elements its selector matches and their descendants, so it is
 * verified against just that subtree, far cheaper than reading the whole render for each of the
 * many element-scoped lines. The universal `*` line reaches every element, so it is checked
 * against the whole render; a selector that will not parse falls back to the same whole-render
 * check. Subtree soundness is the same the prune and logical phases rely on; see subtreeTargets.
 *
 * @param oracle - the mounted render with the candidate reset line inserted
 * @param rule - the reset rule text, its selector read from before the brace
 */
function renderNeutral(oracle: RenderOracle, rule: string): boolean {
	const selector = rule.slice(0, rule.indexOf('{')).trim();
	if (selector.includes('*')) return oracle.matchesReference();
	let elements: Element[];
	try {
		elements = Array.from(oracle.body.querySelectorAll(selector));
	} catch {
		return oracle.matchesReference();
	}
	return oracle.matchesSubset(oracle.subtreeTargets(elements));
}
