// grader orchestrator. wraps render-diff with run history and a few flags:
//
//   --target <file>  which file in each bundle to score (default output.html).
//   --cached         no-op: we score files already on disk (kept for forward compat).
//   --bisect         compare per-case scores between the last two scores.jsonl
//                    entries with the same target; print regressions.
//   --note <text>    free-form label saved on the history entry (e.g. "v2 baseline").
//
// default invocation runs the grader, prints results, and appends one json line
// to scores.jsonl (append-only, one line per run). per-commit grading from
// commit 18 onward uses `node tests/loop.mjs --note "<commit>"`.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gradeAll } from './render-diff.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCORES_PATH = path.join(HERE, 'scores.jsonl');
const REGRESSION_THRESHOLD = 0.01; // 1 score-point drop counts as a regression

function parseFlags(argv) {
	const flags = { cached: false, bisect: false, note: null, target: null };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--cached') flags.cached = true;
		else if (a === '--bisect') flags.bisect = true;
		else if (a === '--note') flags.note = argv[++i] ?? null;
		else if (a === '--target') flags.target = argv[++i] ?? null;
	}
	return flags;
}

/** normalize the target field (string or array) into a stable comparison key. */
function targetKey(entry) {
	if (!entry?.target) return 'default';
	return Array.isArray(entry.target) ? entry.target.join(',') : String(entry.target);
}

async function readHistory() {
	try {
		const raw = await fs.readFile(SCORES_PATH, 'utf8');
		return raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
	} catch (err) {
		if (err.code === 'ENOENT') return [];
		throw err;
	}
}

async function appendHistory(entry) {
	await fs.appendFile(SCORES_PATH, JSON.stringify(entry) + '\n');
}

// compare the last two runs with the same target; report cases whose pixel or
// ssim dropped by more than the threshold, plus new/dropped cases.
async function bisect(targetOverride) {
	const history = await readHistory();
	if (history.length < 2) {
		console.log('bisect needs at least two runs in scores.jsonl; have ' + history.length);
		return;
	}
	const wantKey = targetOverride ? targetKey({ target: [targetOverride] }) : targetKey(history[history.length - 1]);
	const sameTarget = history.filter((h) => targetKey(h) === wantKey);
	if (sameTarget.length < 2) {
		console.log(`bisect needs at least two runs with target ${wantKey}; have ${sameTarget.length}`);
		return;
	}
	const prev = sameTarget[sameTarget.length - 2];
	const curr = sameTarget[sameTarget.length - 1];
	console.log(`comparing ${prev.ranAt}  ->  ${curr.ranAt}  (target: ${wantKey})\n`);

	const prevByKey = new Map(prev.cases.map((c) => [`${c.tier}/${c.name}`, c]));
	const currByKey = new Map(curr.cases.map((c) => [`${c.tier}/${c.name}`, c]));
	const regressions = [];
	for (const [key, c] of currByKey) {
		const p = prevByKey.get(key);
		if (!p) {
			regressions.push({ key, reason: 'new case (no prior score)' });
			continue;
		}
		if (c.error || p.error) {
			if (c.error && !p.error) regressions.push({ key, reason: `now erroring: ${c.error}` });
			continue;
		}
		const dp = c.pixelScore - p.pixelScore;
		const ds = c.ssimScore - p.ssimScore;
		if (dp < -REGRESSION_THRESHOLD || ds < -REGRESSION_THRESHOLD) regressions.push({ key, deltaPixel: dp, deltaSsim: ds });
	}
	for (const [key] of prevByKey) if (!currByKey.has(key)) regressions.push({ key, reason: 'dropped case' });

	if (regressions.length === 0) {
		console.log('no regressions beyond ' + REGRESSION_THRESHOLD);
		return;
	}
	console.log('regressions:');
	for (const r of regressions) {
		if (r.reason) console.log(`  ${r.key.padEnd(28)} ${r.reason}`);
		else console.log(`  ${r.key.padEnd(28)} pixel ${r.deltaPixel.toFixed(4)}   ssim ${r.deltaSsim.toFixed(4)}`);
	}
}

async function main() {
	const flags = parseFlags(process.argv.slice(2));
	if (flags.bisect) {
		await bisect(flags.target);
		return;
	}
	if (flags.cached) console.log('--cached: scoring files already on disk; nothing to skip');

	const result = await gradeAll({ target: flags.target ?? undefined });
	console.log('\nper-case scores:');
	for (const c of result.cases) {
		if (c.error) console.log(`  ${c.tier.padEnd(12)} ${c.name.padEnd(18)} error: ${c.error}`);
		else console.log(`  ${c.tier.padEnd(12)} ${c.name.padEnd(18)} pixel ${c.pixelScore.toFixed(4)}  ssim ${c.ssimScore.toFixed(4)}`);
	}
	console.log(`\naggregate (n=${result.aggregate.cases}, failed=${result.aggregate.failed}):`);
	console.log(`  mean pixel: ${result.aggregate.meanPixel.toFixed(4)}`);
	console.log(`  mean ssim:  ${result.aggregate.meanSsim.toFixed(4)}`);

	await appendHistory({ ...result, note: flags.note });
	console.log(`\nappended to ${SCORES_PATH}`);
}

const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await main();
