/**
 * utils/log.ts — namespaced console logging
 *
 * Phase: a (scaffold) — see SNIPCODE-REWRITE-PLAN.md section 12
 * Pipeline position: n/a (cross-cutting utility)
 *
 * Why this exists: a single prefixed logger so extension output is identifiable
 * in the console and easy to silence. it must never log secrets (byok keys); call
 * sites are responsible for not passing them, and the byok layer never does.
 */

const PREFIX = 'snipcode:';

/** info-level log. */
export function log(...args: unknown[]): void {
	console.info(PREFIX, ...args);
}

/** warning-level log (recoverable problems). */
export function warn(...args: unknown[]): void {
	console.warn(PREFIX, ...args);
}

/** error-level log (failures worth surfacing). */
export function error(...args: unknown[]): void {
	console.error(PREFIX, ...args);
}
