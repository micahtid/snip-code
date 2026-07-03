// Readable-slice report: per bundle, the total index.html size (what a user opens), the
// inlined output.html size, and the font-payload-excluded style-rule slice (the part a user
// actually reads). The M2 win shows as index.html shrinking toward the font-excluded slice
// as the embedded @font-face bytes move into referenced files.
import fs from 'node:fs/promises';
import path from 'node:path';
import { findBundles } from './run-pipeline.mjs';

/** Bytes of the <style> block minus every url() data-uri payload (fonts and inline images). */
function readableSlice(html) {
	const style = (html.match(/<style[^>]*>([\s\S]*?)<\/style>/i) || [, ''])[1];
	return style.replace(/url\(\s*["']?data:[^"')]+["']?\s*\)/gi, 'url()').length;
}

const bundles = await findBundles();
let outTotal = 0, idxTotal = 0, sliceTotal = 0;
console.log('bundle                       output.html   index.html   readable-slice');
for (const b of bundles) {
	let out, idx;
	try { out = await fs.readFile(path.join(b.dir, 'output.html'), 'utf8'); } catch { continue; }
	try { idx = await fs.readFile(path.join(b.dir, 'index.html'), 'utf8'); } catch { idx = null; }
	const outKb = out.length / 1024;
	const idxKb = idx ? idx.length / 1024 : 0;
	const sliceKb = readableSlice(out) / 1024;
	outTotal += out.length; idxTotal += idx ? idx.length : 0; sliceTotal += readableSlice(out);
	const key = `${b.tier}/${b.name}`;
	console.log(`  ${key.padEnd(26)} ${outKb.toFixed(1).padStart(8)}KB ${idxKb.toFixed(1).padStart(9)}KB ${sliceKb.toFixed(1).padStart(11)}KB`);
}
console.log(`  ${'TOTAL'.padEnd(26)} ${(outTotal/1024).toFixed(0).padStart(8)}KB ${(idxTotal/1024).toFixed(0).padStart(9)}KB ${(sliceTotal/1024).toFixed(0).padStart(11)}KB`);
console.log(`\nindex.html is ${(100 * (1 - idxTotal / outTotal)).toFixed(1)}% smaller than the inlined output.html across the corpus.`);
