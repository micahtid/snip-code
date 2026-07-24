// Load-ts: bundle one typescript module out of src/ and import it into the node test
// process. The extension ships as a vite bundle and has no test-time module loader of its
// own, so the unit suite compiles the module under test on the fly with esbuild, which is
// already present as a vite dependency, and imports the result from a data url. No new
// dependency, no build step, and no tsconfig path juggling.
//
// Browser and chrome apis the module touches are not stubbed here. A test stubs whatever
// its module actually reads, on globalThis, before calling load().

import * as esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', 'src');

/**
 * Bundle a src-relative typescript module and import it.
 *
 * @param relPath - path under src/, such as 'utils/storage.ts'
 * @returns the module's exports
 */
export async function load(relPath) {
	const built = await esbuild.build({
		entryPoints: [path.join(SRC, relPath)],
		bundle: true,
		format: 'esm',
		platform: 'browser',
		target: 'es2022',
		write: false,
		logLevel: 'silent',
		// The bundles reference __BUILD_ID__, a vite-injected constant absent under the test
		// bundler; a stable literal stands in so the reset-on-new-build path is inert in tests.
		define: { __BUILD_ID__: JSON.stringify('test') },
	});
	const code = built.outputFiles[0].text;
	return await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}

/**
 * Install a chrome.storage.local stub backed by a plain object, so storage tests run with
 * no browser. Returns the backing store so a test can seed or read it directly.
 *
 * @param seed - initial storage contents
 * @returns the mutable backing store
 */
export function stubChromeStorage(seed = {}) {
	const store = { ...seed };
	globalThis.chrome = {
		storage: {
			local: {
				get: async (key) => (key in store ? { [key]: store[key] } : {}),
				set: async (patch) => {
					Object.assign(store, patch);
				},
			},
		},
	};
	return store;
}
