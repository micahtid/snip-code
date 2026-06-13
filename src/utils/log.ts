/**
 * utils/log.ts: namespaced console logging
 *
 * Pipeline position: n/a (cross-cutting utility)
 *
 * Why this exists: a single prefixed logger so extension output is identifiable
 * in the console and easy to silence. It must never log secrets (byok keys); call
 * sites are responsible for not passing them, and the byok layer never does.
 */

const PREFIX = 'snipcode:';

/** Info-level log. */
export function log(...args: unknown[]): void {
	console.info(PREFIX, ...args);
}

/** Warning-level log (recoverable problems). */
export function warn(...args: unknown[]): void {
	console.warn(PREFIX, ...args);
}

/** Error-level log (failures worth surfacing). */
export function error(...args: unknown[]): void {
	console.error(PREFIX, ...args);
}
