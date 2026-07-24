/**
 * build-env.d.ts: compile-time constants vite substitutes into the bundle.
 *
 * __BUILD_ID__ is stamped by each vite build (see vite.config.ts and
 * vite.content.config.ts) with a value that changes every build. Storage compares it against
 * the last-seen value to reset the shift multi-select hint whenever a fresh build is loaded,
 * so development always sees the hint again rather than having to clear storage by hand.
 */
declare const __BUILD_ID__: string;
