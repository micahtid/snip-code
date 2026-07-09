/**
 * utils/log.ts: namespaced console logging.
 *
 * This is not part of the pipeline. It is a cross-cutting utility.
 *
 * Why this exists: a single prefixed logger so extension output is identifiable in the
 * console and easy to silence. It must never log secrets such as byok keys. Call sites are
 * responsible for not passing them, and the byok layer never does.
 */

const PREFIX = 'snipcode:';

/** Info-level log. */
export function log(...args: unknown[]): void {
	console.info(PREFIX, ...args);
}

/** Warning-level log for recoverable problems. */
export function warn(...args: unknown[]): void {
	console.warn(PREFIX, ...args);
}

/** Error-level log for failures worth surfacing. */
export function error(...args: unknown[]): void {
	console.error(PREFIX, ...args);
}
