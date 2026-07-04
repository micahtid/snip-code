/**
 * minimize/reset.ts: inject the canonical reset preamble
 *
 * Pipeline position: minimize, after var inlining and before the closing prune rerun
 * Reads from Captured: page.viewport via the oracle; warnings on graceful skip
 * Writes to Captured: nothing; transforms the stylesheet string
 *
 * Why this exists: the reproduce phase bakes `box-sizing: border-box` onto every rule and
 * restates the inherited font on every control, because it copies each element's full
 * computed style. A human writes the two lines everyone knows once, at the top, and lets the
 * cascade carry them. This injects that canonical reset, then the prune rerun that follows
 * deletes the per-rule restatements the reset now makes redundant, so `box-sizing` appears
 * once instead of on hundreds of rules.
 *
 * Each reset line is an addition candidate, the reverse of prune's deletion: it is inserted
 * at the top of the sheet and kept only when the computed-style oracle confirms it changed no
 * element's render. The `*` selector carries zero specificity, so any real rule overrides it;
 * a sheet that already sets `border-box` everywhere is unchanged by the reset and accepts it,
 * while the rare element left at `content-box` keeps its own rule and vetoes nothing. A line
 * the oracle rejects is simply not injected.
 */
import type { Captured } from '../types';
import { createRenderOracle } from './oracle';
import { serializeRules } from './declarations';

/**
 * The canonical minimal reset, each line the widely known human idiom. Injected one at a
 * time and kept only when render-neutral, so the output never gains a rule that shifts it.
 */
const RESET_RULES = [
	'*, *::before, *::after { box-sizing: border-box; }',
	'button, input, select, textarea { font: inherit; color: inherit; }',
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
	if (!css.trim() || !markup.trim()) return css;
	let oracle;
	try {
		oracle = await createRenderOracle(captured, css, markup);
	} catch (err) {
		captured.warnings.push(`minimize: reset skipped (${(err as Error).message})`);
		return css;
	}
	try {
		oracle.captureReference();
		let injected = 0;
		for (const rule of RESET_RULES) {
			try {
				oracle.sheet.insertRule(rule, injected); // Keep accepted resets first, in order.
			} catch {
				continue; // Unparseable in this engine; skip it.
			}
			if (oracle.matchesReference()) injected++;
			else oracle.sheet.deleteRule(injected); // Not neutral here; do not inject.
		}
		if (injected === 0) return css;
		return serializeRules(Array.from(oracle.sheet.cssRules));
	} catch (err) {
		captured.warnings.push(`minimize: reset skipped (${(err as Error).message})`);
		return css;
	} finally {
		oracle.dispose();
	}
}
