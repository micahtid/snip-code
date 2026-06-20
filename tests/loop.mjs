// Grader orchestrator. Wraps render-diff with run history and a few flags:
//
// --target <file> which file in each bundle to score (default output.html).
// --cached no-op: we score files already on disk (kept for forward compat).
// --bisect compare per-case scores between the last two scores.jsonl
// entries with the same target; print regressions.
// --note <text> free-form label saved on the history entry (e.g. "v2 baseline").
//
// Default invocation runs the grader, prints results, and appends one json line
// to scores.jsonl (append-only, one line per run). Per-commit grading uses
// `node tests/loop.mjs --note "<commit>"`.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gradeAll } from './render-diff.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCORES_PATH = path.join(HERE, 'scores.jsonl');
const REGRESSION_THRESHOLD = 0.01; // 1 score-point drop counts as a regression

// Success-criteria thresholds, from FIDELITY-PLAN.md. A bundle is blank when its
// render carries less than INK_FLOOR ink while its reference clears REF_INK_MIN.
const INK_FLOOR = 0.02; // 2% non-white pixels
const REF_INK_MIN = 0.02; // Reference must itself have visible content to count
const MEAN_SSIM_TARGET = 0.97;
const MIN_SSIM_TARGET = 0.9;

/** A case is blank when its render has near-zero ink but its reference does not. */
function isBlank(c) {
	return typeof c.ink === 'number' && typeof c.refInk === 'number' && c.ink < INK_FLOOR && c.refInk >= REF_INK_MIN;
}

/**
 * Reports whether the corpus meets the plan's exit condition: no blanks, mean SSIM
 * at or above target, and no single bundle below the floor. Prints the verdict and
 * lists every bundle that still fails a criterion.
 */
function reportCriteria(result) {
	const scored = result.cases.filter((c) => !c.error);
	const blanks = scored.filter(isBlank);
	const belowFloor = scored.filter((c) => !isBlank(c) && c.ssimScore < MIN_SSIM_TARGET);
	const meanOk = result.aggregate.meanSsim >= MEAN_SSIM_TARGET;
	console.log('\nsuccess criteria:');
	console.log(`  no blanks:        ${blanks.length === 0 ? 'PASS' : `FAIL (${blanks.map((c) => `${c.tier}/${c.name}`).join(', ')})`}`);
	console.log(`  mean ssim >=${MEAN_SSIM_TARGET}:  ${meanOk ? 'PASS' : `FAIL (${result.aggregate.meanSsim.toFixed(4)})`}`);
	console.log(`  all ssim >=${MIN_SSIM_TARGET}:    ${belowFloor.length === 0 ? 'PASS' : `FAIL (${belowFloor.map((c) => `${c.tier}/${c.name}=${c.ssimScore.toFixed(2)}`).join(', ')})`}`);
}

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

/** Normalize the target field (string or array) into a stable comparison key. */
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

// Compare the last two runs with the same target; report cases whose pixel or
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
		if (c.error) {
			console.log(`  ${c.tier.padEnd(12)} ${c.name.padEnd(18)} error: ${c.error}`);
			continue;
		}
		const ink = typeof c.ink === 'number' ? `ink ${(c.ink * 100).toFixed(1)}%` : '';
		const blank = isBlank(c) ? '  BLANK' : '';
		const probe = c.droppedProps || c.droppedEls ? `  drop ${c.droppedProps ?? 0}p/${c.droppedEls ?? 0}e` : '';
		console.log(`  ${c.tier.padEnd(12)} ${c.name.padEnd(18)} pixel ${c.pixelScore.toFixed(4)}  ssim ${c.ssimScore.toFixed(4)}  ${ink}${probe}${blank}`);
	}
	console.log(`\naggregate (n=${result.aggregate.cases}, failed=${result.aggregate.failed}):`);
	console.log(`  mean pixel: ${result.aggregate.meanPixel.toFixed(4)}`);
	console.log(`  mean ssim:  ${result.aggregate.meanSsim.toFixed(4)}`);
	reportCriteria(result);

	await appendHistory({ ...result, note: flags.note });
	console.log(`\nappended to ${SCORES_PATH}`);
}

const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await main();
