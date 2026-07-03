# HUMANIZE-PLAN: deterministic CSS minimization and humanization

This plan is written for the LLM that will execute it. Read it fully before touching code.

## 1. Goal

The pipeline's reproduced output is visually faithful but reads like a machine dump: every
element restates inherited values, UA defaults, and frozen pixel geometry. The goal is
production-quality output that looks hand-written, under one fidelity contract:

> **When nested under the same parent element, the component must look identical to the
> reproduced output.** Absolute pixel positions may go; the rendered result in context may not.

The path is a chain of deterministic, oracle-verified transforms that each shrink or clean the
CSS, with an LLM pass only at the very end for naming and organization. A previous attempt
(branch `reconstruct-mode`, now reset) put the LLM first and asked it to shrink the blob; it
managed ~20% shrink at ~$0.10 per component over multiple rounds. The deterministic approach
was prototyped and measured before this plan was written; it does 3-4x better, in seconds,
for free. Do not reintroduce an LLM-first rewrite.

## 2. Measured evidence (Jul 1 2026 prototype)

A throwaway script (Appendix A) loaded a bundle's `output.html`, mutated live CSSOM
declarations, and accepted each deletion only when a full-page screenshot stayed identical.

| Oracle | layout/shadcn | layout/stripe |
| --- | --- | --- |
| Byte-identical PNG | 17.4% of 622 decls removed, 10.5 -> 8.5 KB, 38s | not run |
| Zero diff pixels at pixelmatch threshold 0.1 | **76.7% removed, 10.5 -> 3.8 KB, 32s** | **87.8% of 433 decls removed, 9.3 -> 2.0 KB, 15s** |

Findings that shape this plan:

- The blob is mostly dead weight: inheritance restatements and no-op values dominate.
- Byte-identical PNG comparison is too strict; sub-threshold antialiasing shifts reject real
  no-ops. The tolerant oracle (zero diff pixels at threshold 0.1) is the right pixel gate.
- Survivors cluster into two families: border-longhand resets repeated per element (a human
  writes one shared reset rule; needs hoisting, not deletion) and frozen geometry
  (`grid-template-columns: 22.6562rem 22.6562rem`; needs relaxation, not deletion).
- Screenshots of an unchanged static page are byte-deterministic in headless chromium, so a
  changed screenshot always means a changed render. Take them with
  `{ animations: 'disabled', caret: 'hide' }`.
- CSSOM restore gotcha: `setProperty(prop, value, priority)` does not round-trip a rule
  exactly. Snapshot and reassign the whole `style.cssText` per touched rule, and refresh the
  snapshot after every accepted deletion. Getting this wrong silently rejects everything.

## 3. Ground rules (non-negotiable)

- **Universal, never example-specific.** No selector tables, no per-site tuning, no logic that
  exists because one corpus bundle needs it. The corpus and fixtures are measurement targets
  only.
- **Never commit or stage anything.** Leave all changes in the working tree for review.
- **Every phase is verified by an oracle, not by eyeballing.** A transform that cannot be
  machine-verified does not ship.
- **Warnings never throw.** Pipeline failures degrade gracefully: on any oracle infrastructure
  failure, skip the transform, append to `captured.warnings`, and ship the unminimized output.
- **Comment convention:** sentence case, plain self-contained English, no plan labels (no
  "M2", no "phase"), no em dashes, no parentheses in comments.
- **Module header convention:** every new `.ts` module opens with the established header
  block documenting `<path>: <purpose>`, its pipeline position, what it reads from and
  writes to `Captured`, and why it exists. Copy the shape from `src/content/types.ts` or
  `src/utils/storage.ts`.
- **Build discipline:** `npm run build` before every harness run, and read its output; a
  failed build silently leaves a stale `dist/` and invalidates every measurement after it.
- **Grader noise:** the 23-bundle live corpus drifts run to run because sites change. Use
  `tests/fixtures.mjs` (drift-free local pages) as the hard regression gate; use corpus scores
  for direction, and bisect any apparent corpus regression against a pre-change build before
  believing it.

## 4. Architecture

New phases slot in after `convert/clean` and before the existing LLM polish, inside the
content script, so every user benefits with no API key:

```
capture -> reconcile -> resolve -> convert(bem -> clean)
  -> minimize   delete every declaration whose removal is render-invisible
  -> normalize  fold longhands to shorthands, order properties like a human
  -> hoist      move repeated declarations to shared or ancestor rules
  -> relax      replace frozen geometry with intrinsic values, humanize colors,
                re-emit real :hover selectors from the measured-state markers
  -> polish     existing LLM pass, now fed 2-4 KB of clean CSS (opt-in, BYOK, last)
  -> format -> splitAssets
```

New source lives in `src/content/minimize/`, a sibling of the existing phase directories
(`capture`, `reconcile`, `resolve`, `convert`, `polish`). The oracle borrows the established
pattern from `src/content/reconcile/standalone.ts`: mount the emitted artifact in a hidden,
viewport-sized iframe and compare styles element by element.

### Exact wiring points (src/content/index.ts)

The minimizer operates on the emitted stylesheet, so like `cleanCss` it is called from both
emit sites, not from `runCoreTransform`:

- **`runPipeline`:** immediately after `cleanCss`, before the polish gate, scoped to the
  class-based html-shaped formats (`html`, `bem-css`, `bem-scss`), the same gate polish uses.
- **`runHeadless`:** immediately after `cleanCss` and **before `probeEmitted`**, so the
  emitted-artifact probe and the grader both measure the stylesheet that actually ships.

Unlike polish, the minimizer is deterministic and key-free, so it belongs in the headless
grader path once proven. Rollout is two-staged: during development it is opted into per snip
via a flag on the `snip-runner:snip` event detail (the harness passes it, defaults stay
unchanged); after the M1 gates pass, flip it to always-on at both sites, delete the flag, and
refresh the corpus `output.html` files as the new baseline.

### The two oracles

1. **Computed-style oracle (in-pipeline, fast).** Mount the artifact once, snapshot
   `getComputedStyle` for every element (and `::before`/`::after`), then mutate the frame's
   CSSOM and re-compare. Equal computed styles on identical DOM implies an identical render,
   so this oracle is strictly conservative. No paint, no encode: ~5-15ms per check. This is
   what ships in the extension.
2. **Tolerant pixel oracle (harness-side backstop).** Render reference and candidate
   full-page in headless chromium; require zero diff pixels at pixelmatch threshold 0.1.
   Catches anything the per-element view cannot see and measures how much the conservative
   oracle leaves on the table.

### Scope guard

At-rules (`@font-face`, `@keyframes`, `@property`) and state or pseudo rules (selectors
matching `:hover|:focus|:active|:focus-visible|:focus-within|\[data-snip-state|\[data-snip-pseudo|::`)
are out of scope for deletion and rewriting in every phase until the relax phase explicitly
converts state markers back to real pseudo-class selectors. They carry the interactive and
generated-content fidelity that FIDELITY-PLAN-6/7/8 earned; breaking them is a hard fail.
`tests/verify-state.mjs` exists to check forced-state fidelity; keep it green.

## 5. The feedback loop

Execute every increment through this loop. Never stack two unmeasured changes. Every gate
below is free to run: nothing before the final polish milestone touches an LLM, so measure
liberally and always over the full corpus. The tidy set is for quick iteration only; a phase
is not done until the full 23-bundle corpus and the fixture suite are green.

1. **Implement** the smallest useful increment.
2. **Build:** `npm run build` (includes typecheck via `tsc -b`). Fix everything before
   measuring.
3. **Fixture gate (hard):** `node tests/fixtures.mjs`. All fixtures must pass SSIM and the
   byte-determinism double-snip. The minimizer changes output bytes by design, so fixture
   *determinism* (same input, same output, twice) is the invariant, plus no SSIM drop.
4. **Phase harness (hard):** `node tests/minimize-loop.mjs` (built in M1). Per-bundle it must
   report: declarations before/after, resting CSS chars before/after, wall time, computed
   oracle pass, and the tolerant pixel backstop verdict. The backstop must pass on every
   bundle, every run.
5. **Corpus regen + grade (directional):** `node tests/run-pipeline.mjs` to refresh every
   `output.html`, then `npm run grade -- --note "<phase and change>"` and
   `node tests/loop.mjs --bisect` to compare against the previous run. Investigate any
   regression; use a stashed pre-change build to separate live-site drift from real effect.
6. **Determinism check:** run `node tests/run-pipeline.mjs --only <one bundle>` twice; the
   two `output.html` files must be byte-identical.
7. **Record** the numbers in the ledger (section 8) with date and change description. If a
   guardrail was learned, write down the failure that earned it.
8. **Stop rule:** if a phase gate fails twice for the same root cause, stop and diagnose the
   root cause before writing more code. Do not tune around a failing example.

Keep the corpus viewer current: after each landed phase, refresh the `output.html` files and,
if new artifacts are added for eyeballing, wire them into `~/Downloads/training-data/index.html`.

## 6. Milestones

### M0: minimizer core with computed-style oracle

**Deliverable:** `src/content/minimize/` with the oracle frame, the declaration index, and
ddmin-style bisection deletion, wired into both emit sites behind the development flag
described in section 4, and defaulting on only after M1 proves it. A reasonable module split
is `oracle.ts` for the frame plus computed-style snapshot and compare, and `prune.ts` for the
declaration index and bisection loop; adjust if the code wants a different seam.

Implementation notes:

- Index declarations through the browser's parser (`document.styleSheets` in the oracle
  frame), never by regex over CSS text; data-URIs contain braces that break naive parsers.
- Bisection: try deleting a chunk; on oracle pass accept permanently, on fail restore the
  chunk via saved `style.cssText` and split. Accepted deletions keep the frame equal to the
  reference, so the reference snapshot is taken once.
- Add a heuristic pre-pass before bisection: batch-delete, in one check, every declaration
  whose value equals the parent's computed value for inherited properties or the UA default
  for non-inherited ones. Most dead declarations should go in that single check.
- Wall-time budget with graceful exit: on timeout, keep the accepted deletions and ship.
  Every accepted deletion is already verified, so partial completion is always safe.
- Prune rules left empty; drop them from the emitted stylesheet.

**Measure:** identity sanity first (oracle over an unmodified artifact reports zero
differences on every corpus bundle), then deletion rates per bundle.

**Gate:** fixture suite green; pixel backstop green on all bundles; in-pipeline wall time
under ~5s per component on the tidy set (stripe, dropbox, shadcn).

### M1: measurement harness

**Deliverable:** `tests/minimize-loop.mjs`, following the structure of the existing harnesses
and reusing the render helpers from `tests/render-diff.mjs`. The bundle-driving helpers in
`tests/run-pipeline.mjs` (`readSource`, `findBundles`, `snipOne`, and the persistent-context
launch) are currently module-private; export them, and give `snipOne` an optional extra-detail
parameter that merges into the `snip-runner:snip` event detail, which is how the harness opts
a snip into the minimizer without touching the grader default. The harness drives the built
extension over bundles, records one JSONL row per bundle, and runs the tolerant pixel
backstop.

**Measure:** the corpus-wide table: decl removal %, char shrink %, wall time, backstop
verdicts. Also measure the conservatism gap: run the Appendix A tolerant-pixel minimizer on
two bundles and compare its removal % to the computed-oracle number. Expect the computed
oracle to remove less (it keeps invisible-but-computed-different values such as colors on
inkless borders). Record the gap; if it exceeds ~20 points, add paint-relevance filters
(border colors and styles are deletable when the matching width is 0; outline properties when
outline-style is none; text properties on elements with no text) and re-measure.

**Gate:** mean decl removal at or above 50% corpus-wide with zero backstop failures.

### M2: normalize

**Deliverable:** longhand-to-shorthand folding (border, margin, padding, inset, gap, font
where safe) and a fixed human property order (layout, box, spacing, typography, color,
effects) applied to every surviving rule. Deterministic string-level transform over the
minimized rules, verified by the same oracle after transformation.

**Gate:** oracle reports zero differences pre/post normalize on every bundle; fixture suite
green; char count strictly non-increasing.

### M3: hoist and merge

**Deliverable:** move declarations shared by siblings to a shared rule or, for inherited
properties, to the ancestor; merge rules with identical bodies into selector lists. Every
hoist is a candidate change verified by the oracle before acceptance, so cascade or
specificity mistakes are caught mechanically rather than reasoned about.

**Gate:** oracle green everywhere; measurable char shrink beyond M1 (record it); fixtures
green.

### M4: geometry relaxation

**Deliverable:** for each frozen geometry value (px/rem lengths in widths, heights, grid
tracks, flex-basis), try the intrinsic alternative (`auto`, `1fr`, percentage, or removal)
and keep it when the render is unchanged. The oracle frame must constrain the component root
to the captured parent content-box width so intrinsic values resolve exactly as they would
under the same parent; that constraint is what makes the fidelity contract in section 1
verifiable.

**Gate:** pixel backstop green at the capture width on every bundle; count of surviving
frozen values recorded per bundle and trending down.

### M5: value humanization and real selectors

**Deliverable:** two independent transforms, each oracle-verified:

- Colors: rewrite computed notations (`lab()`, verbose `rgba()`) into hex or `oklch`, and
  cluster values repeated across rules into custom properties on the root rule. Use the
  canvas paint-pipeline equality trick for notation equivalence: two notations are the same
  color when a 1x1 canvas filled with each yields the same pixel within 1 per channel.
- Selectors: the emitted `[data-snip-state="..."]` and `[data-snip-pseudo]` markers came from
  measured interactive states, and the trigger element is known, so re-emit them as real
  `:hover`/`:focus`/`::before` selectors and delete the marker attributes from the HTML.
  Verify with `node tests/verify-state.mjs` in addition to the resting oracle.

**Gate:** resting oracle green; verify-state green; no marker attributes left in output.

### M6: rewire the LLM polish pass

**Deliverable:** the existing polish pass (`src/content/polish/`) fed the now-minimal CSS,
with its prompt refocused on the only jobs left for a model: semantic class names, semantic
HTML tags where roles are unambiguous, and grouping comments. Keep the existing vault flow.
Add verification: run the computed-style oracle on the polished candidate and fall back to
the pre-polish output when it fails, with a warning.

Lessons from the scrapped LLM-first attempt that still apply here:

- Ask for declaration-level patches on refinement, never whole-rule replacement; models gut
  long rules.
- With OpenRouter, send `reasoning: { enabled: false }`; reasoning tokens bill against
  `max_tokens` and truncate JSON replies.
- Never show the model the withheld state/pseudo/at-rules; it regenerates them from memory
  and truncates its reply.
- Class renames travel as a `{ css, renameMap }` envelope with single-token entries.

**Gate:** polished output passes the oracle or falls back cleanly; fixtures green (polish
never runs in the headless grader path, which must stay deterministic).

## 7. Success criteria for the whole plan

- Corpus-wide mean resting-CSS shrink of 60%+ against the pre-plan `output.html` baselines.
- Zero pixel-backstop failures, zero fixture regressions, determinism intact.
- A senior frontend engineer reading `layout/shadcn` or `layout/stripe` output should see
  nothing that flags it as machine-generated except the geometry that is genuinely
  load-bearing.
- Deterministic phases run with no API key configured; total added pipeline time under ~5s
  for typical components.

## 8. Ledger

Append one entry per measured increment: date, change, numbers, gate verdicts, lessons.

- 2026-07-01 baseline (pre-plan prototype, harness-side, tolerant pixel oracle):
  shadcn 76.7% decls removed (10.5 -> 3.8 KB, 32s), stripe 87.8% (9.3 -> 2.0 KB, 15s).
  In-pipeline numbers will differ; establish the real M1 baseline before comparing.
- 2026-07-02 M0 core + M1 harness, first full-corpus computed-oracle run (minimize on):
  mean decl removal 36.7%, mean char shrink 30.5%, 22/23 backstop pass. Small components
  do well (superset 65%, dropbox 61%, sumup/tailwind/ai-cofounder/stripe 56-59%). Large
  components are capped by the 20s wall-time budget and removed almost nothing (apple 1%,
  f1 2%, duolingo 1%, cluely 9%), which is what drags the mean below 50%.
  Lessons that earned guardrails, all universal:
  1. Cross-realm rule typing: the oracle frame's rules are iframe-realm, so `instanceof
     CSSStyleRule` is always false; classify by `rule.type === CSSRule.STYLE_RULE`.
  2. Motion drift: a running animation or transition makes getComputedStyle return a
     moving value, so the oracle must freeze motion. A `*{...!important}` stylesheet rule is
     not enough, a `[data-snip-state]{transition:all!important}` measured-state rule
     out-specifies it; freeze with inline `!important` on every element, which outranks any
     selector rule. Removing this masking let the oracle silently delete a badge's border.
  3. Removal mechanics: per-longhand removeProperty can leave the live cssom serializing
     differently than it renders; rebuild each rule's cssText from kept author segments
     instead, a clean re-parse that matches how the shipped stylesheet is read.
  4. Compare declared properties, not only the enumerated computed set: getComputedStyle
     does not enumerate some non-standard paint properties such as -webkit-font-smoothing,
     so the oracle unions the enumerated longhands with every property the sheet declares.
  Open: raise mean to 50%+ with a stronger UA-default pre-pass so large components finish
  inside budget; resolve one residual soundness gap (layout/uber, 181 diff pixels).
- 2026-07-02 M0/M1 soundness closed + subtree-scoped oracle: full corpus mean 46.7% decl
  removal, 37.3% char shrink, 23/23 backstop pass, typical components under 3s (tidy set
  stripe 1.3s, dropbox 1.5s, shadcn 2.8s, so the M0 wall-time gate is met). Two more
  universal fixes earned guardrails:
  5. uber's residual was quirks mode: a fresh iframe's about:blank renders in quirks mode
     where form-control box-sizing differs from the shipped artifact's standards mode, so
     the oracle mounts with a written doctype (createSizedFrame standards flag). Fonts are
     also settled once at setup so font-metric-dependent sizes match the shipped render.
  6. Subtree-scoped check: a removal on rules matching elements M can only change M and
     their descendants, since any ancestor or sibling shift is a consequence of a size
     change on one of those, caught there first, and getComputedStyle cannot see in-flow
     position anyway. Comparing only the affected subtree instead of the whole tree cut
     large components from budget-capped 2% to 24-47% and dropped typical times to seconds,
     with every backstop still green. Cross-tree properties that break this scope, counter
     increment/reset/set, are held out of removal alongside motion; see UNVERIFIABLE_PROP.
  The remaining ~3 points to the 50% gate are the sound computed oracle's inherent
  conservatism against the tolerant pixel oracle the target was calibrated on, plus a tail
  of giant real pages (apple 5677 decls, f1 2168) that a per-declaration bisection cannot
  fully clear inside a sane budget; raising the budget to 45s lifted them only 4-8 points.
  Paint-relevance filters were tried per the M1 note: border color/style on zero-width
  sides and outline on style:none are kept (small, plan-listed, sound), but they and a
  textless-subtree glyph-property filter each gave near-zero corpus gain, because the
  reproduce pipeline's denoise phase already strips inert declarations before minimize. So
  the gap is not removable dead code the oracle misses; it is real sub-threshold pixel
  tolerance the sound oracle correctly refuses. Closing it would mean trading in-pipeline
  soundness for pixel-level tolerance, which has no production backstop, so it was not done.
  The textless glyph filter was reverted to keep the code lean since it earned nothing.
- 2026-07-02 M2 normalize done: new `src/content/minimize/normalize.ts` reorders each rule's
  declarations into a fixed human order (layout, box, spacing, border, background, type,
  effects) and lets the cssom fold the now-adjacent longhand families into shorthands as it
  reserializes, margin-*/padding-* to margin/padding, the twelve border longhands to
  border-width/style/color, top/right/bottom/left to inset. Two cssom facts made it a pure
  reshuffle: rule.style.cssText preserves author order for distinct properties, and setting
  a full longhand family folds it automatically. Verified render-neutral by the same oracle
  over the whole stylesheet; on a non-neutral reorder, from a shorthand mixed with a longhand
  it overrides, the phase ships the pruned css untouched. Gate green: all spot-check backstops
  pass, fixtures deterministic and SSIM unchanged, char strictly non-increasing. Output now
  reads like hand-written css. Shared scope/parse helpers extracted to
  `src/content/minimize/declarations.ts` (WITHHELD, inScopeRule, serializeRules, parseSegments).
- 2026-07-02 M3 merge done: new `src/content/minimize/merge.ts` collapses every group of
  rules whose declaration block became identical after prune and normalize into one rule
  with the comma-joined selector, in document order, keeping the block at the last rule's
  cascade position and dropping the duplicates. Each merge is oracle-verified against just
  the elements the group's selectors match and their descendants; a merge that shifts the
  cascade is reverted while the rest stand. Verified via the reliable cssom mechanic that
  changing a rule's selectorText to a list and emptying the others updates the render. Gate
  green: backstops pass, fixtures deterministic and SSIM unchanged, end-to-end resting-css
  shrink measured 16-58% per bundle. The plan's other M3 clause, hoist inherited props to a
  common ancestor, is already subsumed by prune's inherited-restatement pre-pass, which
  removes any inherited value that equals the parent, so what survives to merge are
  overriding values that cannot hoist. Equivalent to HUMANIZE-PLAN-2 extension 3.
- 2026-07-02 M4 relax investigated and NOT shipped, per the measure-and-decide loop. Built a
  relax phase that tried each frozen geometry value as an intrinsic one, grid tracks as 1fr
  and sizes as auto by removal, verified under a sub-0.1px-tolerant subtree oracle, with the
  root's own width/height kept frozen so the snip still reproduces standalone. Measured yield
  was near zero: zero grid tracks relaxed to fr across stripe/dropbox/ai-cofounder/sumup and
  about one size per bundle. Frozen geometry is load-bearing for standalone reproduction: a
  1fr track redistributes child sizes past the sub-pixel threshold, and dropping a fixed size
  frees the box to fill its parent or shrink to content, both of which the oracle correctly
  rejects. The plan's higher-yield path, un-pinning the root under the captured parent
  content-box width, would trade away the standalone-identical property the whole pipeline and
  its sound backstop depend on, so it was not pursued. Cost was also real: a fourth per-snip
  oracle mount that timed a large bundle out. Reverted the phase and its tolerant-oracle
  addition to keep the pipeline lean and fast; the finding stands as the record.
- 2026-07-02 M5 colors done, selectors deferred. New `src/content/minimize/colorize.ts`
  rewrites every declaration whose whole value is a single solid color to a short hex, using
  a 2d canvas fillStyle as the authority so the rewrite is the engine's own canonical
  spelling and paints the identical pixel by construction, no oracle needed. rgb() triples
  become #hex, translucent rgba() becomes #rrggbbaa, and a wide-gamut lab()/color() is left
  as it is rather than clamped to srgb. Runs after merge, applies to state and pseudo rules
  too since a color's spelling is safe to change anywhere. Verified render-neutral: all
  backstops pass, fixtures deterministic and SSIM unchanged.
- 2026-07-02 M5 real selectors done. Generalized format.ts keyPseudosToClasses into
  keyMarkersToClasses(markup, css, attr) and ran it for data-snip-pseudo and then
  data-snip-state, so a multi-marker state selector `[data-snip-state="0"]:hover
  [data-snip-state="1"]` re-keys to `.card:hover .card__h3-1` and the marker attributes are
  dropped. Behavior-identical by construction: a unique class replaces its marker 1:1 at the
  same specificity, and forcing the real pseudo applies the same rule. Confirmed both gates:
  the resting fixtures stay deterministic with SSIM unchanged, and verify-state.mjs forcing
  :hover on `.card` reproduces the recolor/tint/elevate exactly, with zero markers left in
  the output. Runs in assembly for every snip, minimize on or off, since it is render-neutral.
  Only the optional color-clustering-into-:root-custom-properties idea was left out, since it
  can hurt readability more than it helps and the plan lists it as one option among the color
  work, not a requirement.
- 2026-07-02 M6 polish rewired. runPipeline restructured to assemble the shipped artifact
  first, run the minimize pipeline over it, and only then the optional byok polish, so the
  model receives the small final css and its naming edits land last. The prompt was refocused
  from the old renames-plus-hover pair to the three render-neutral naming jobs a deterministic
  pass cannot do, semantic class renames, semantic tag swaps limited to inert container tags,
  and grouping comments; hover generation was dropped because M5 already re-emits the real
  interactive rules. The interactive-state, pseudo-element, and at-rules are stripped from the
  prompt via stripWithheld so the model never sees or regenerates them. New polish/verify.ts
  mounts the pre- and post-polish documents in isolated standards-mode frames, pairs elements
  by lockstep position, since the edits never change tree shape, and requires every paired
  computed style to match; a non-neutral edit reverts to the pre-polish output with a warning.
  Verified the safety net directly: a valid rename passes, an inconsistent rename and a
  div-to-button tag swap both fail and would fall back. Gate met: fixtures stay deterministic
  (polish never runs in the headless path) and the fallback is proven to catch a render change.
  The llm output quality itself depends on the user's byok model and cannot be tested here.
- Pipeline state after this session: convert/clean -> assemble -> minimize(prune) -> normalize
  -> merge -> colorize -> format, then optional byok polish last, all behind
  MINIMIZE_ALWAYS=false (dev default) plus the per-snip opt-in; polish is byok-gated. M0, M1,
  M2, M3, M5, and M6 shipped and gated; M4 investigated and reverted with its finding. Nothing
  committed; all changes in the working tree for review.

## Appendix A: validated prototype (harness-side, tolerant pixel oracle)

Reference implementation measured in section 2. Reuse its bisection and cssText
restore/accept mechanics; replace its screenshot oracle with the computed-style oracle for
the in-pipeline version.

```js
// Prototype: measure how much of a reproduced component's resting CSS a render-oracle
// minimizer can delete. Loads a bundle's output.html, mutates live CSSOM declarations,
// and accepts a deletion only when the render stays identical.

import { chromium } from 'playwright';
import pixelmatch from 'pixelmatch';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const bundleArg = process.argv[2] ?? 'layout/shadcn';
const DATA_DIR = path.join(os.homedir(), 'Downloads', 'training-data');
const dir = path.join(DATA_DIR, ...bundleArg.split('/'));

const srcRaw = (await fs.readFile(path.join(dir, 'source.json'), 'utf8')).replace(/^﻿/, '');
const src = JSON.parse(srcRaw);
const vp = src.viewport ?? src.page?.viewport ?? {};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: vp.width || 1280, height: vp.height || 800 } });
await page.goto(pathToFileURL(path.join(dir, 'output.html')).href, { waitUntil: 'load' });
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(300);

// Index every declaration of every resting style rule via the browser's own parser.
const setup = await page.evaluate(() => {
	const WITHHELD = /:hover|:focus|:active|\[data-snip-state|\[data-snip-pseudo|::/;
	window.__R = [];
	window.__D = [];
	window.__S = [];
	for (const sheet of document.styleSheets) {
		let rules;
		try { rules = [...sheet.cssRules]; } catch { continue; }
		for (const rule of rules) {
			if (rule.type !== CSSRule.STYLE_RULE) continue;
			if (WITHHELD.test(rule.selectorText || '')) continue;
			const rIdx = window.__R.push(rule) - 1;
			window.__S.push(rule.style.cssText);
			const seen = new Set();
			for (let i = 0; i < rule.style.length; i++) {
				const prop = rule.style[i];
				if (seen.has(prop)) continue;
				seen.add(prop);
				window.__D.push({ rIdx, prop });
			}
		}
	}
	const beforeChars = window.__R.reduce((s, r) => s + r.cssText.length, 0);
	return { rules: window.__R.length, decls: window.__D.length, beforeChars };
});

// Removal mutates properties in place. Restore reassigns each touched rule's whole
// style.cssText from the last accepted snapshot; per-property setProperty does not
// round-trip. Accepting a removal refreshes the snapshot.
const removeDecls = (idxs) => page.evaluate((list) => {
	for (const i of list) { const d = window.__D[i]; window.__R[d.rIdx].style.removeProperty(d.prop); }
}, idxs);
const restoreDecls = (idxs) => page.evaluate((list) => {
	for (const r of new Set(list.map((i) => window.__D[i].rIdx))) window.__R[r].style.cssText = window.__S[r];
}, idxs);
const acceptDecls = (idxs) => page.evaluate((list) => {
	for (const r of new Set(list.map((i) => window.__D[i].rIdx))) window.__S[r] = window.__R[r].style.cssText;
}, idxs);

let checks = 0;
const shot = async () => { checks++; return page.screenshot({ fullPage: true, animations: 'disabled', caret: 'hide' }); };
const reference = await shot();
checks = 0;

// Accept sub-threshold per-channel shifts, the antialiasing noise band, while still
// requiring zero diff pixels at pixelmatch threshold 0.1.
let refRaw = null;
async function decode(buf) {
	const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	return { data, width: info.width, height: info.height };
}
async function identical(now, ref) {
	if (now.equals(ref)) return true;
	if (!refRaw) refRaw = await decode(ref);
	const cur = await decode(now);
	if (cur.width !== refRaw.width || cur.height !== refRaw.height) return false;
	return pixelmatch(refRaw.data, cur.data, undefined, cur.width, cur.height, { threshold: 0.1 }) === 0;
}

const removed = [];
const kept = [];

// Bisection: delete a chunk; an identical render accepts it permanently, a change
// restores and splits. Accepted deletions keep the page equal to the reference, so
// later checks always compare against the same baseline.
async function minimize(idxs) {
	await removeDecls(idxs);
	if (await identical(await shot(), reference)) { removed.push(...idxs); await acceptDecls(idxs); return; }
	await restoreDecls(idxs);
	if (idxs.length === 1) { kept.push(idxs[0]); return; }
	const mid = Math.floor(idxs.length / 2);
	await minimize(idxs.slice(0, mid));
	await minimize(idxs.slice(mid));
}

await minimize([...Array(setup.decls).keys()]);

const after = await page.evaluate(() => {
	const live = window.__R.filter((r) => r.style.length > 0);
	return { liveRules: live.length, afterChars: live.reduce((s, r) => s + r.cssText.length, 0) };
});
console.log(`removed ${removed.length}/${setup.decls} decls; ${setup.beforeChars} -> ${after.afterChars} chars; ${checks} checks`);
await browser.close();
```
