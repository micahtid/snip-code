/**
 * vite.config.ts
 *
 * build config for the sidebar ui (react). Emits the side-panel html + js
 * bundle into dist/, and copies everything under public/ (manifest, background
 * service worker, icons, preview) into dist/ verbatim.
 *
 * The content script is a separate build (see vite.content.config.ts) because it
 * must be a single self-contained iife with no code-splitting — chrome injects
 * it as one file, so rollup's default multi-chunk output would break it.
 *
 * Sourcemaps are on for debuggable production builds.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
	plugins: [react()],
	// Stamp a per-build id so storage can reset the shift hint on every fresh build.
	define: { __BUILD_ID__: JSON.stringify(String(Date.now())) },
	// public/ is the default static dir; manifest.json + background.js + icons
	// + preview.* Live there and are copied to dist/ untouched.
	publicDir: 'public',
	build: {
		outDir: 'dist',
		emptyOutDir: true,
		sourcemap: true,
		rollupOptions: {
			// index.html is the side-panel entry point.
			input: 'index.html',
		},
	},
});
