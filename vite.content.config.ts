/**
 * vite.content.config.ts
 *
 * separate build for the content script (src/content/index.ts). chrome injects a
 * content script as a single file in the page's isolated world, so the output
 * must be one self-contained bundle with no dynamic import / code-splitting and
 * a stable filename (dist/content.js, no hash) the manifest can point at.
 *
 * kept apart from the sidebar build (vite.config.ts) because the two have
 * incompatible output shapes: the sidebar is an html-driven multi-chunk app, the
 * content script is a flat iife.
 */
import { defineConfig } from 'vite';

export default defineConfig({
	// do not re-copy public/ here; the sidebar build already populates dist/.
	publicDir: false,
	build: {
		outDir: 'dist',
		// never wipe the sidebar build output that ran first.
		emptyOutDir: false,
		sourcemap: true,
		lib: {
			entry: 'src/content/index.ts',
			formats: ['iife'],
			name: 'SnipCodeContent',
			fileName: () => 'content.js',
		},
		rollupOptions: {
			output: {
				// single file, predictable name for the manifest content_scripts entry.
				entryFileNames: 'content.js',
				inlineDynamicImports: true,
			},
		},
	},
});
