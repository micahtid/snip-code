// Fidelity classifier. Reads the per-bundle sidecars the pipeline runner writes
// (emitted-probe.json, probe.json) plus the shipped output.html and sorts each bundle's
// residual into exactly one family, so a fix is routed to its real cause rather than a
// visual guess:
//
//   delta B (emitted vs inline-clone render)  -> convert/emit cascade loss
//   delta A absent from emitted css           -> value absent at capture/bake
//   delta A present but rendered differently  -> another render-time mechanism
//   surviving http(s):// resource urls        -> origin gap (fonts/images not inlined)
//   silently dropped elements                 -> structural drop
//
// All inputs are deterministic and drift-free (the probe diffs computed styles in an
// isolated iframe, and the url scan is a static read), so this table is a stable
// baseline the measurement loop compares against. Run: `node tests/classify.mjs`.

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DATA_DIR = path.join(os.homedir(), 'Downloads', 'training-data');

// A delta counts as "material" only above this many diverging properties. A handful
// of sub-pixel or enum-spelling differences is noise, not a family-defining residual.
const MATERIAL = 3;

/**
 * Count fetchable http(s) RESOURCE urls in the output. The self-containment gate is
 * about resources the artifact must fetch to render (a font src, an image src/srcset, a
 * css url()), not navigation targets. An `<a href>` to another page is a legitimate
 * external link, never a self-containment violation, so it is excluded. So are w3.org
 * xml-namespace identifiers, which are never fetched.
 */
function countRemoteUrls(html) {
	const resources = [
		...html.matchAll(/url\(\s*['"]?(https?:\/\/[^'")\s]+)/gi),
		...html.matchAll(/\bsrc\s*=\s*['"](https?:\/\/[^'"]+)/gi),
		...html.matchAll(/\bsrcset\s*=\s*['"]([^'"]*https?:\/\/[^'"]*)/gi),
	].map((m) => m[1]);
	return resources.filter((u) => !/^https?:\/\/(www\.)?w3\.org\//.test(u)).length;
}

async function readJson(p) {
	try {
		return JSON.parse(await fs.readFile(p, 'utf8'));
	} catch {
		return null;
	}
}

async function findBundles() {
	const out = [];
	for (const tier of await fs.readdir(DATA_DIR, { withFileTypes: true })) {
		if (!tier.isDirectory()) continue;
		const tierDir = path.join(DATA_DIR, tier.name);
		for (const c of await fs.readdir(tierDir, { withFileTypes: true })) {
			if (!c.isDirectory()) continue;
			const dir = path.join(tierDir, c.name);
			if (await readJson(path.join(dir, 'source.json'))) out.push({ tier: tier.name, name: c.name, dir });
		}
	}
	out.sort((a, b) => (a.tier + a.name).localeCompare(b.tier + b.name));
	return out;
}

/** The root-cause families a bundle's residual lands in. */
function families(b) {
	const fam = [];
	if (b.remoteUrls > 0) fam.push('origin');
	if (b.deltaB >= MATERIAL) fam.push('cascade');
	if (b.absent >= MATERIAL) fam.push('absent-bake');
	if (b.droppedEls > 0) fam.push('dropped-el');
	// delta A is material but it is neither cascade nor absent. That points to a non-emit
	// render-time mechanism (a collapsed stacking context, an unresolved external
	// reference, or generated content).
	if (b.deltaA >= MATERIAL && b.deltaB < MATERIAL && b.absent < MATERIAL && b.droppedEls === 0) fam.push('render-time');
	if (fam.length === 0) fam.push('clean');
	return fam;
}

async function main() {
	const bundles = await findBundles();
	const rows = [];
	for (const bundle of bundles) {
		const emit = await readJson(path.join(bundle.dir, 'emitted-probe.json'));
		const probe = await readJson(path.join(bundle.dir, 'probe.json'));
		let remoteUrls = 0;
		try {
			remoteUrls = countRemoteUrls(await fs.readFile(path.join(bundle.dir, 'output.html'), 'utf8'));
		} catch {
			// No output.html, so leave it at 0. The row will read as un-snipped.
		}
		rows.push({
			key: `${bundle.tier}/${bundle.name}`,
			deltaA: emit?.deltaA?.droppedProps ?? null,
			deltaB: emit?.deltaB?.droppedProps ?? null,
			absent: emit?.absentProps ?? null,
			droppedEls: probe?.droppedEls ?? 0,
			remoteUrls,
			topB: (emit?.deltaB?.topProps ?? []).slice(0, 4).map((p) => `${p.prop}:${p.count}`).join(' '),
			topA: (emit?.deltaA?.topProps ?? []).slice(0, 4).map((p) => `${p.prop}:${p.count}`).join(' '),
		});
	}

	console.log('fidelity classification (deterministic, drift-free)\n');
	console.log('bundle'.padEnd(26), 'dA'.padStart(5), 'dB'.padStart(5), 'abs'.padStart(5), 'elD'.padStart(4), 'url'.padStart(4), ' families');
	for (const r of rows) {
		const f = families(r);
		console.log(
			r.key.padEnd(26),
			String(r.deltaA ?? '-').padStart(5),
			String(r.deltaB ?? '-').padStart(5),
			String(r.absent ?? '-').padStart(5),
			String(r.droppedEls).padStart(4),
			String(r.remoteUrls).padStart(4),
			' ' + f.join(','),
		);
	}

	// This is a per-family roll-up, so an empty family (no work needed in that area) is visible.
	const tally = new Map();
	for (const r of rows) for (const f of families(r)) tally.set(f, (tally.get(f) ?? 0) + 1);
	console.log('\nfamily roll-up:');
	for (const [f, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${f.padEnd(20)} ${n}`);

	console.log('\ntop delta-B (emit cascade) properties, worst bundles:');
	for (const r of rows.filter((r) => (r.deltaB ?? 0) >= MATERIAL).sort((a, b) => b.deltaB - a.deltaB)) {
		console.log(`  ${r.key.padEnd(26)} dB=${r.deltaB}  ${r.topB}`);
	}
	console.log('\ntop delta-A (vs live) properties, worst bundles:');
	for (const r of rows.filter((r) => (r.deltaA ?? 0) >= MATERIAL).sort((a, b) => b.deltaA - a.deltaA)) {
		console.log(`  ${r.key.padEnd(26)} dA=${r.deltaA} abs=${r.absent}  ${r.topA}`);
	}
}

const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await main();
