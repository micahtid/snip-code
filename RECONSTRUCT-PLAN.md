# Reconstruct Plan — a readable, hand-written-looking component, verified against the pixel-perfect reproduction

Every snip today is a **reproduction**: the pipeline bakes the browser's *computed*
result onto each element and ships it. That is why fidelity is near-perfect and why the
code reads as machine output — frozen geometry (`grid-template-columns: 32.6562rem
32.6562rem 0px`), synthesized class names (`startups-program-card-grid__group-4--3`),
and a flat, exhaustive declaration dump. The verbosity is not a defect; it is the price
of reproducing a layout **without re-running the page's own cascade and layout engine**.

This document proposes a second, opt-in output mode — **reconstruction** — that emits the
same component the way a programmer would write it (semantic layout, shorthands,
inherited defaults, flexible tracks), and proves it is visually identical using
infrastructure the repo already has. It is a sibling of the existing `polish` phase, not
a rewrite of any existing one.

This document is **findings + design only. No code has been changed.** Like the fidelity
plans, the design is a **hypothesis tested in a feedback loop** against hard gates
(resting byte-determinism of the reproduce path, no corpus SSIM regression), not a set of
changes assumed correct. And the plan is **executed** as a feedback loop: each change is
run against a real LLM over live components and measured before the next step — see
§"Execution as a feedback loop." Every claim below is tied to a file/line in this repo, a
measurement over the live corpus, or an external source; see §11.

---

## The question this plan answers

**How do we produce a readable component (X), in a way that matches this codebase's
existing phase/BYOK/verify architecture (Y), to accomplish a hand-written-quality output,
as cheaply as possible and with a guarantee of no visual regression (Z)?**

- **Z — the goal.** Measured over the live corpus (`~/Downloads/training-data`, 23
  bundles), a component's *actual* structure is tiny: after stripping images, Stripe is
  **14 KB** of code across **51 elements**, Dropbox **14 KB** across **49 elements** (the
  full Dropbox file is 1.2 MB — **99% base64 image**, already externalized by
  `convert/assets.ts:43`). A hand-written version of Stripe's two-card grid is on the
  order of **~15 lines of CSS** versus the **326 declarations across 33 rules** it ships
  today — a **5–10× reduction**, concentrated in the small, hand-CSS-heavy components
  (Stripe drops 10.2% of CSS *lines* from the safe lossless pass alone; the reconstruction
  ceiling is far higher).
- **Y — the standard to match.** A five-phase pipeline threading one mutable `Captured`
  object (`types.ts:28`); an optional, BYOK-gated, best-effort `polish` phase that returns
  `{ html, css, warning?, usage? }` (`polish/llm.ts:48`); a deterministic per-element
  render oracle (`reconcile/standalone.ts`); and an offline SSIM/pixelmatch corpus grader
  (`tests/render-diff.mjs`, `npm run grade`).
- **X — the mechanism.** A new optional phase, `reconstruct`, shaped exactly like
  `polish`, that runs the current state-of-the-art **generate → render → diff → refine**
  loop and **only accepts a candidate that its own oracle certifies as within tolerance**,
  otherwise falling back to the reproduced output.

---

## Why reconstruction is possible here when it is hard everywhere else

The design-to-code field has converged on one architecture: generate a candidate, render
it, feed the visual difference back, and refine — **Design2Code** conditions the model on
screenshots of both the target and its own render and revises to match; **ReLook** and
**UI2Code^N** use a vision critic to drive iterative refinement and report that quality
*improves with every step*. Single-pass generation is now considered obsolete for this
task.

Those systems chase an *approximate* match because they have **no ground truth** — they
start from a screenshot. **We start from a reproduction that is already pixel-correct, and
we hold, for every element, its exact live computed box.** That gives us two things no
screenshot-to-code tool has:

1. **A perfect target.** The reproduced output is the reference; we are not guessing what
   the design "should" look like.
2. **A deterministic, sub-0.1px, in-browser oracle** — `reconcile/standalone.ts` already
   mounts a clone in an isolated UA-only iframe (`createSizedFrame`, `standalone.ts:809`),
   pairs it element-by-element against the live tree (`zip`, `standalone.ts:837`), and
   compares every computed property with `valuesMatch` (`standalone.ts:475`), which treats
   two values as equal iff every embedded number matches to one decimal place. This runs
   **with no screenshot** and is the signal the codebase already trusts to gate before
   SSIM is believed.

So the reconstruction loop's "critic" is not a fuzzy vision model scoring a heatmap. It is
the repo's existing exact-geometry diff, which can already say *"element `.card--2`
renders 480px wide; target is 523px"* — by class and by pixel. That is the difference
between "looks about right" and "provably within tolerance."

---

## Where it fits: a sibling of `polish` (matching Y)

The pipeline order (from `index.ts:122` `runCoreTransform` and `index.ts:222`
`runPipeline`) is:

```
capture → reconcile → resolve → convert(bem → clean → [polish] → format → splitAssets)
```

`polish` (`index.ts:270`) is optional, BYOK-gated, restricted to class-based formats
(`html`/`bem-css`/`bem-scss`), receives the already-emitted `{ finalHtml, cleanedCss }`,
returns `{ html, css, warning?, usage? }`, and is **excluded from the deterministic
`runHeadless` grader** (`index.ts:501`). Reconstruction inherits all of these properties:

- **New phase directory `src/content/reconstruct/`**, matching the `polish/` layout
  (`llm.ts` orchestrator, `prompts.ts`, `apply.ts`, `verify.ts`).
- **Runs in `runPipeline` only**, in the convert band. It is an *alternative* to `polish`,
  not stacked on top: reconstruction subsumes semantic renaming (polish's `renameMap`), so
  a component either goes through the light `polish` pass or the heavier `reconstruct`
  pass, selected by a preference. Both remain BYOK and best-effort.
- **Never runs in `runHeadless`.** The deterministic grader path stays byte-identical, so
  the corpus determinism gate (`tests/fixtures.mjs:197`, `first.html === second.html`) is
  unaffected — reconstruction is additive and off by default.
- **Signature mirrors polish** so the orchestration edit is one call:
  `reconstruct(html, css, captured, provider, model) → { html, css, warning?, usage? }`.
  Unlike polish it *does* take `captured`, because its oracle needs the live element and
  the baked clone (see §"The accept/reject gate").

Failure is best-effort exactly as every phase is: a `try/catch` that on any error pushes
`"reconstruct: skipped (<message>)"` onto `captured.warnings` and returns the reproduced
input unchanged (`denoise.ts:83`, `assets.ts:67` establish the convention). A missing key
is a silent no-op (`polish/llm.ts:61`). **The reproduced output is always the floor** —
reconstruction can only replace it, never degrade it, because a candidate ships only if
the oracle certifies it.

### Relationship to `polish` — one slot, dispatch not stack

The pipeline keeps its **single optional LLM slot** (today's polish step at `index.ts:270`).
That slot dispatches by preference — `if pref = deep, reconstruct(...); else polish(...)` —
so a snip still makes **0 or 1** LLM pass, never two, and the panel's `usage`/`warning`
wiring is unchanged. Reconstruction runs **instead of** polish, never on top of it: it
already produces semantic names and preserves the measured interactive states, so stacking
the two would be redundant.

They stay **separate modules** because their safety contracts differ — polish is additive
and provably safe with no verify loop; reconstruct is lossy and ships only behind the
oracle. `reconstruct/` reuses polish's *plumbing* (the `requestLlm` broker, `VerbatimVault`,
`pruneOrphans`), not its pass logic, so there is no duplication. Semantic naming lives
**inside** reconstruct's own prompt — naming while it understands structure beats renaming
blind afterward. Priming reconstruct with polish's names first is a measurable idea, not a
default: `reconstruct-loop.mjs` can A/B it, but the expected result is that reconstruct
names at least as well on its own. If deep mode ever proves reliable enough, polish could
later collapse into "reconstruct with structural rewrite disabled" — an earned
simplification, never a starting assumption.

---

## The mechanism (X), step by step

### 1. Two tiers, gated by whether the oracle can still align trees

The per-element oracle (`zip`/`pairedSubtrees`, `match.ts:75`) requires the candidate and
the reference to be **structurally-identical trees walked in lockstep**. That constraint
cleanly splits the work into two tiers, and it is the single most important design
decision in this plan:

- **Tier 1 — CSS-only rewrite (tree-preserving).** Keep the exact DOM tree and the
  element→rule correspondence; rewrite only the *rules*: collapse frozen tracks to
  flexible ones (`32.6562rem 32.6562rem` → `1fr 1fr`), drop baked geometry in favour of
  flow (`display:grid; gap`), fold longhands into shorthands, and apply semantic class
  names. Because the tree is unchanged, the deterministic per-element oracle aligns
  perfectly and certifies per-element drift to sub-0.1px **with no screenshot** (a cheap
  whole-frame pixel check still backstops cross-element effects — see §"The accept/reject
  gate"). Ceiling: cannot remove wrapper elements, but this is where most of the readability
  win lives, and it is *precisely* verifiable.
- **Tier 2 — structural reconstruction (tree-changing).** Also collapse wrapper divs and
  merge elements into genuinely hand-written markup. Higher readability ceiling, but the
  per-element oracle can no longer align the trees, so verification falls back to
  **pixel-only** SSIM/pixelmatch (`render-diff.mjs`), which is fuzzier and slower.

**This plan proposes shipping Tier 1 first**, behind the deterministic oracle, and treating
Tier 2 as a later, separately-gated experiment. Tier 1 is safe, cheap to verify, and
captures the bulk of the shrink; Tier 2 trades a real fidelity guarantee for cosmetic
wrapper removal and should not block Tier 1.

### 2. The feedback signal: structured per-element deltas, not a score

A bare SSIM number ("0.87") is unactionable. The loop must hand the model a *localized,
named* description of what drifted. The repo already produces exactly this: `probeStandalone`
(`standalone.ts:196`) emits, per element, `{ path, prop, live, standalone }` samples plus
aggregate `droppedProps`/`topProps`. For a candidate we run the same
`probeEmitted`-style two-frame diff (`standalone.ts:366`) and translate its output into
feedback keyed by the candidate's own class names:

```
.card-grid__group-4--2  width      → want 523px, got 480px
.header                 margin-top → want 16px,  got 12px
```

This is the answer to "how will it know which area it messed up": **by class name and
pixel delta**, because both the target and the candidate expose computed styles per
element. Computed style also carries paint (`color`, `background-color`, `box-shadow`), so
the per-element diff catches most colour/shadow errors too — a rendered screenshot is only
needed as a backstop for cross-element effects (overlap, z-order, actual gradient pixels).

### 3. The broker constraint: return a JSON envelope, not raw CSS

The background broker rejects any reply that does not contain `{`
(`background.js`, `NON_JSON_REPLY`), and `requestLlm(provider, model, prompt, max?)`
returns `{ text | null, error?, usage? }` (`content/llm.ts:35`). `polish` satisfies this
by asking for *instructions* (`renameMap`/`hoverRules`) as JSON. Reconstruction genuinely
rewrites code, so it wraps the rewrite in a JSON envelope that satisfies the same guard and
parses cleanly:

```json
{ "css": "<reconstructed stylesheet>", "html": "<reconstructed markup, Tier 2 only>" }
```

Parsing reuses the lenient first-`{…}` brace match (`polish/llm.ts:84`) or
`inspect/ai.ts`'s `firstJsonObject`. Token-heavy, fragile values (svgs, gradients,
multi-layer shadows, long URLs) are replaced with `@@V*@@` placeholders by
`VerbatimVault.protect` (`convert/vault.ts:52`) before the model sees them and restored
with `vault.restore` afterward (`vault.ts:154`, split/join so a `$` cannot be mangled) —
so the model never spends tokens on, or corrupts, a base64 blob.

Output token ceilings are ample: the broker caps at 8192 (anthropic/google/openrouter) /
16384 (openai), default 2000 (`background.js` `PROVIDER_MAX_TOKENS`); a reconstructed
stylesheet is ~1–2K tokens, so the pass calls `requestLlm(..., max)` with an explicit
raise, matching the `max` parameter polish omits.

### 4. Prompt caching: put the stable prefix first

The refine loop sends the same component code 2–4 times; only the feedback changes. Prompt
caching is a **prefix match** — the stable prefix caches once and is re-read at ~0.1× on
later rounds, halving the loop's input cost. The prompt is therefore ordered:

```
[ stable — cached ]  instructions  +  the vaulted baked CSS (the reference)
--------------------- cache breakpoint ---------------------
[ volatile ]         this round's per-element deltas  (+ optional cropped image)
```

The whole loop runs in seconds, well inside the 5-minute cache TTL, so the cache stays warm
across rounds. Estimated cost per component: **~$0.05 (Haiku) to ~$0.25 (Opus)**, roughly
halved by caching (current pricing: Haiku 4.5 $1/$5, Sonnet 5 $3/$15, Opus 4.8 $5/$25 per
MTok). It is BYOK, so this lands on the user who opts in, and it is one-time per component,
not per view. Latency (an Opus refine loop can run minutes), not cost, is the real
constraint — so the default model resolves via the existing
`modelOverrides[provider] ?? DEFAULT_MODELS[provider]` idiom (`index.ts:271`), where the
BYOK defaults already favour fast models (`utils/byok.ts`: openrouter `gemini-2.5-flash`,
anthropic `claude-haiku-4-5`).

### 5. The accept/reject gate

A candidate is accepted only if it passes **all three** checks below, reusing the existing
thresholds. The first is the precise primary signal; the second and third close what a
resting per-element diff alone cannot see.

- **Per-element resting geometry + paint (primary).** Every paired element's computed
  values match under `valuesMatch` (sub-0.1px), i.e. `probeEmitted` reports zero
  unexplained `droppedProps` for size/inset/paint props. This catches the vast majority of
  drift by class name and pixel, deterministically and with no screenshot.
- **Per-frame pixel/SSIM (required secondary, not optional).** The per-element diff is
  blind to *cross-element* effects — z-order, stacking contexts, overlap — because those
  can shift with an identical per-element box. So the candidate frame is also rendered and
  compared to the baked frame: SSIM ≥ `MEAN_SSIM_TARGET` 0.97, no region below
  `MIN_SSIM_TARGET` 0.90, ink coverage above `INK_FLOOR` 0.02 (`tests/loop.mjs:24`). For
  Tier 2 (tree-changing) this is the *only* available gate; for Tier 1 it is a cheap
  backstop on top of the exact per-element check.
- **Interactive-state fidelity.** The resting oracle reads `getComputedStyle` at rest and
  therefore cannot verify `:hover`/`:focus`/`:active`. The measured state rules the
  pipeline already produces (`capture/states-measure.ts` → `reconcile/features/states.ts`)
  are **vaulted verbatim** so the model cannot drop or rewrite them, and the candidate is
  additionally checked with the existing forced-state path (`tests/verify-state.mjs`, which
  drives `CSS.forcePseudoState` via CDP) — each measured state is forced and the before/after
  must match the reproduced output. Without this, a dropped `:hover` rule would slip the
  resting gate silently.

If after `MAX_ROUNDS` rounds no candidate passes all three, **the reproduced output ships
unchanged** and a `warning` records that reconstruction did not converge. There is no path
by which reconstruction produces a worse-looking result than today's output.

---

## Cost discipline: spend tokens only where intelligence is required

Cheapness is a first-class goal here, not an afterthought, and the implementation should
weigh it at every step. The vault already proved the pattern for the polish pass: strip the
token-heavy values before the model sees them and the bill drops hard. Reconstruction
extends that with one guiding rule. **The LLM does only what needs intelligence. Everything
mechanical happens in deterministic code first, everything sent is minimized, everything
returned is minimized, and the loop stops the moment a candidate passes.**

Techniques, applied throughout:

- **Vault first.** Reuse `VerbatimVault` so base64, svgs, gradients, shadows, and long urls
  never reach the model. This is the biggest single input cut and it also stops the model
  corrupting data it cannot see.
- **Do the mechanical wins in code, not tokens.** `denoise` already removes inherited and
  default repetition, and the lossless logical-to-physical collapse can run deterministically
  too. The model receives an already-minimal input and is asked only for the structural
  re-expression that code cannot do.
- **Skip components that cannot benefit.** A cheap deterministic pre-check skips the LLM
  entirely for components that are image-dominated, tiny, or already simple. Zero tokens are
  spent where there is no win.
- **Cheapest model first.** Default to a fast, cheap model and escalate to a stronger one
  only when the measured convergence rate on a component is poor.
- **Cache the reference, send only deltas.** Prompt caching holds the stable baked reference
  at about one tenth cost. Refine rounds send only the small named per-element deltas, never
  the whole component again.
- **Patch, not full rewrite, on refine.** After the first candidate the model returns only
  the rules it is changing, not the entire stylesheet each round. This mirrors polish
  returning instructions rather than code, and it cuts output tokens on every refine round.
- **Tight output ceiling.** `max` is sized to the component, well below the provider cap, so
  a runaway response cannot burn tokens.
- **Accept the first pass.** The loop stops as soon as a candidate clears the gate. It never
  spends the full round budget out of habit.
- **Learn once, save forever.** A recurring failure becomes a standing prompt guardrail, so
  later components converge in fewer rounds. Learning is itself a cost saving.

Cost is a tracked metric, not a hope. Every `reconstruct-loop.mjs` run records tokens and
dollars per component, and a rising cost trend is treated as a regression to investigate,
exactly like a fidelity regression.

---

## Universality: what the oracle makes moot, and what it does not

**The feature is universal by construction, not by coverage.** It applies to *every*
component, not a favoured subset: the accept/reject gate rejects any candidate that drifts
on any site for any reason, and a component that will not converge falls back to its exact
reproduction. So reconstruction is *safe* everywhere and *never regresses* — the shrink
*benefit* concentrates where a component is hand-CSS-heavy and gracefully vanishes
(fallback) on image-heavy or unusual ones, but no component is ever made worse. Nothing in
the design may be tuned to the test components; per the codebase's standing "universal, not
example-specific" rule, the test set exists to *measure* convergence, never to hardcode
site-specific CSS. Ground truth (the oracle) always wins over any table of per-site fixes.

Earlier scripting over the corpus surfaced the classic lossless-cleanup traps, and it is
worth stating which the oracle handles for free and which still require care:

- **Handled by the oracle for free.** The logical/physical dedup landmine — 6 corpus
  elements carry `width: 100%` *and* `inline-size: 80rem` (a fluid width with a fixed cap),
  where naive "drop the logical twin" regresses layout — cannot slip through, because any
  such regression changes the element's computed box and the per-element gate rejects the
  candidate. The oracle is a universal backstop: *any* drift, from any cause, on any site,
  fails the gate. This is why reconstruction is safer here than a hand-written rule engine.
- **Still worth encoding as prompt guidance** (cheaper than discovering via rejected
  rounds). The corpus is 100% `horizontal-tb` LTR (zero `writing-mode`, zero real
  `direction: rtl` — every `rtl` hit is inside base64), so `inline-size ≡ width` holds
  today; a *universal* pass must still respect writing-mode/RTL, and form controls
  (`<button>` in 16/23 bundles) break font inheritance, so the model should be told to keep
  `font`-family/size on `button`/`input` or emit `font: inherit`. These are guardrails that
  reduce wasted refine rounds, not correctness requirements — the gate is the correctness
  requirement.

Note also that the heavy lifting of the *lossless* cleanup is already done:
`reconcile/denoise.ts` removes inherited/default repetition against ground-truth probes
(one corpus file drops `-webkit-font-smoothing` from 217 of 229 rules). Reconstruction is
not competing with denoise; it goes after the structural verbosity denoise deliberately
leaves — frozen geometry and non-semantic class names — which only a re-expression of
intent can remove.

---

## Milestones (each independently gated)

Each milestone's gate is measured live by `tests/reconstruct-loop.mjs` against OpenRouter
(see §"Execution as a feedback loop"); none is "done" until its loop run passes the gates
on the tidy set and spend is well under $5.

1. **M0 — Oracle-as-a-service.** Extract the shared mount-and-diff primitives
   (`createSizedFrame`/`zip`/`valuesMatch`) so that **both** `standalone.ts` and a new
   `reconstruct/verify.ts` use them with **no copy-paste** (matching the de-duplication
   discipline of commit `4039e83`). `verify.ts` then, given a candidate `{ html, css }`,
   mounts it, diffs against the live targets, and returns structured per-element deltas +
   a pass/fail. Pure reuse; no LLM; no spend. Gate: on the reproduced output itself it must
   report zero drift (identity check) — the harness's own smoke test.
2. **M1 — Single-shot Tier 1 on one component.** Wire the BYOK pass (vault → prompt →
   `requestLlm` → parse envelope → apply) with **one** generation round, verify, accept or
   fall back. Prove on Stripe: measure the shrink and the exact per-element residual.
3. **M2 — The refine loop.** Feed M0's deltas back for up to `MAX_ROUNDS`; add prompt
   caching (stable prefix). Gate: converges on the tidy corpus components (Stripe, Dropbox,
   shadcn) within budget.
4. **M3 — Preference + panel wiring.** A `reconstruct` toggle in preferences; thread
   `usage` through `shipResult` so the panel totals it (matching `index.ts:299`); surface
   non-convergence via the existing `warnings` channel.
5. **M4 (separate, later) — Tier 2 structural reconstruction**, pixel-only gated. Only if
   M1–M3 prove the loop is reliable and someone actually reads the output (see risks).

---

## Execution as a feedback loop

This plan is not implemented open-loop and then graded at the end. Following the fidelity
plans' discipline, **every change is validated against a real LLM over live components
before the next step is taken**, and the numbers in this document (the 5–10× shrink, the
per-component cost, the convergence assumption) are treated as *hypotheses to confirm
live*, not facts. The loop is: implement one increment → run it against OpenRouter over a
few tidy components → measure convergence, residual drift, shrink, and spend → adjust the
prompt/loop → repeat.

### The execution harness

A new `tests/reconstruct-loop.mjs`, built on the existing `run-pipeline.mjs` bridge (the
`snip-runner:snip` CustomEvent path every `tests/*.mjs` harness uses). Per run it:

1. Reads `OPENROUTER_API_KEY` (and `RECONSTRUCT_BUDGET_USD`, default 5) from the machine
   env or a git-ignored `.env.local` (see `.env.example`). **The key is never written to a
   tracked file.**
2. Before snipping, injects the key into the page's `chrome.storage.local` under
   `byok.openrouter` and sets prefs (`activeProvider: 'openrouter'`, reconstruction on), so
   the **real broker path** (`background.js` `llmRequest` → OpenRouter) is exercised, not a
   bypass.
3. Snips a small set of tidy, hand-CSS-heavy components (Stripe, Dropbox, shadcn — where
   the intent floor is smallest and the shrink largest), running the full generate → verify
   → refine loop.
4. Appends one JSON line per component to `tests/reconstruct-scores.jsonl` (mirroring
   `scores.jsonl`): `{ component, tier, rounds, converged, residualProps, cssLinesBefore,
   cssLinesAfter, shrinkPct, tokens, usdSpent }`, and prints pass/fail against the
   §"accept/reject gate" thresholds.

### Model and budget

- **Model:** the OpenRouter default `google/gemini-2.5-flash` (`utils/byok.ts`) — cheap and
  fast. The refine loop *compensates for a weaker model* by iterating, so start cheap and
  only escalate (Sonnet/Opus via `modelOverrides`) if the measured convergence rate is
  poor. This keeps the loop well inside budget.
- **Budget — two enforced layers.** (1) **Enforceable cap:** set a **$5 credit limit on
  this key in the OpenRouter dashboard** — as of this writing the key has `limit: null`
  (no cap), so this must be done manually; it is the only truly enforceable ceiling. (2)
  **Loop guard (defense-in-depth):** the harness polls `GET
  https://openrouter.ai/api/v1/auth/key`, records baseline `usage` at start, and **aborts
  before any generation that would push cumulative spend past baseline +
  `RECONSTRUCT_BUDGET_USD` ($5)**. Every run also prints `usdSpent` so a single loop can
  never quietly drain credit.

### What each iteration decides

The loop is the source of truth for the open questions this document could only estimate:

- **Convergence** — what fraction of components reach zero residual within `MAX_ROUNDS`,
  and at what mean round count? Low convergence → refine the prompt guardrails (writing-mode,
  form-control inheritance, "don't touch `@@V*@@`") *before* escalating the model.
- **Residual analysis on failures** — when a candidate is rejected, the per-element deltas
  (`{path, prop, live, standalone}`) name the exact rule and miss; that becomes the next
  prompt fix, exactly as the fidelity plans turned a measured residual into the next change.
- **Real shrink** — `shrinkPct` per component confirms or corrects the 5–10× estimate on
  live output, not a hand mock-up.
- **Real cost** — `usdSpent` confirms or corrects the ~$0.05–0.25/component estimate.

### Two levels of learning from mistakes

The loop corrects itself at two scales, and both are mechanical, not vibes:

- **Within a component (intra-loop):** each refine round is driven by the *exact*
  per-element deltas of the previous round — the model corrects **named** mistakes
  (`.card--2 width want 523 got 480`), never guesses. This converges one component.
- **Across components (inter-loop):** a residual that recurs — say, dropped `font` on a
  `<button>`, or a collapsed `1fr` that should have stayed fixed — is promoted to a
  **standing guardrail** in `reconstruct/prompts.ts`, so the *next* component never repeats
  it. Each recurring failure and the guardrail that fixed it is recorded in a short lessons
  note beside `reconstruct-scores.jsonl`, so the prompt improves monotonically instead of
  re-deriving the same fixes every run.

This is exactly the fidelity plans' discipline — turn a measured residual into the next
concrete change — applied both per-round and per-corpus.

No milestone is called "done" until its `reconstruct-loop.mjs` run passes the gates on the
tidy set and the spend line is well under $5.

## Hard gates (borrowed from the fidelity plans' discipline)

- **The reproduce path stays byte-deterministic.** Reconstruction never runs in
  `runHeadless`; `npm run grade` and `tests/fixtures.mjs`'s `first.html === second.html`
  determinism check are unaffected because the feature is off by default.
- **No corpus SSIM regression.** With reconstruction off, `render-diff.mjs` scores are
  identical to today by construction.
- **Reconstruction is strictly additive.** A component either ships its certified
  reconstruction or its unchanged reproduction — never anything in between, never anything
  worse.

---

## Risks and open decisions

- **Who reads the output?** This is the prerequisite, not a detail. Reconstruction is
  effort spent making the *code* readable; if the output's only consumer is a renderer, the
  reproduced form is already correct and this is polish no one sees. **Decide the consumer
  before M1.** The research is blunt that generated code is a first draft needing human
  review — reconstruction is worth building only if a human is the audience.
- **Latency, not cost.** A refine loop with a slow model is seconds-to-minutes per
  component. Default to fast models; reserve Opus for hard cases; consider running
  reconstruction lazily (on demand from the panel) rather than inline in every snip.
- **Tier 2 loses the deterministic oracle.** Tree-changing reconstruction can only be
  pixel-verified. Do not let its higher ceiling pull Tier 1's guarantee down with it — ship
  them separately.
- **Offline grading of a non-deterministic pass.** Because the LLM path is
  non-deterministic it cannot be a byte-determinism gate; its quality is gated at runtime by
  its own oracle, and evaluated in aggregate by `tests/reconstruct-loop.mjs` (see §"Execution
  as a feedback loop"), which records convergence rate + mean shrink + spend, never by the
  determinism check.

---

## New files (each with the standard header)

Matching the `polish/` layout and the file-header template
(`dir/file.ts: lowercase summary` → `Pipeline position:` / `Reads from Captured:` /
`Writes to Captured:` → thesis → `Why this exists:`), named exports only, tabs, JSDoc
`@param name - desc`:

- `src/content/reconstruct/llm.ts` — orchestrator `reconstruct(html, css, captured,
  provider, model)`, the generate→verify→refine loop; best-effort try/catch → `warnings`.
- `src/content/reconstruct/prompts.ts` — the strict-JSON reconstruction prompt (Tier-1
  tree-preserving instructions + universality guardrails), and the per-round feedback
  formatter.
- `src/content/reconstruct/verify.ts` — the oracle: mount a candidate, diff per-element
  against live targets via the lifted `standalone.ts` machinery, return deltas + pass/fail.
- `src/content/reconstruct/apply.ts` — swap the reproduced `{ html, css }` for the
  certified candidate, restore vaulted placeholders (`vault.restore`), prune orphans
  (reuse `polish/restore.ts` `pruneOrphans`).

**DRY is a hard requirement, not a nicety** — the repo just ran a de-duplication pass
(`4039e83`) and centralizes shared logic (`requestLlm`, `safeMatches`, `subtreeElements`,
`triggerDownload`). `reconstruct/` must therefore **reuse, never re-implement**: it calls
the existing `requestLlm` broker (`content/llm.ts`), `VerbatimVault` (`convert/vault.ts`),
`pruneOrphans` (`polish/restore.ts`), the `standalone.ts` mount/diff primitives extracted
in M0, and the shared `NO_KEY`/`usage`/`warning` skip idiom (already common to
`polish/llm.ts` and `inspect/ai.ts`). Rule: if a helper it needs already exists elsewhere,
export and share that one; if two modules would need the same *new* logic, it lives in one
place both import — never a second copy. Any duplication is a defect caught in the
self-audit below.

Each file carries the standard header: a title line, then `Pipeline position:`,
`Reads from Captured:`, `Writes to Captured:`, a one-line thesis, and `Why this exists:`. It
adds a provenance note wherever logic is lifted from `standalone.ts` or `polish/`.

**Comment style, enforced in every new file:**

- Keep them tight and in plain English. Say why the code exists, not what each line does.
- Use sentence case. Lowercase domain terms like css, html, and llm. Put identifiers in
  backticks.
- No em dashes and no parentheses inside comments. Split the thought into short sentences
  instead.
- Keep them self-contained. No plan or phase labels such as `M0`, `Tier 1`, or step numbers.

Per the UI-styling and clean-code invariants these are new files declared in the spec, with
no `.css` files, single-purpose, named exports only, and tab-indented. Each stage is
best-effort: a `try/catch` that appends `reconstruct: skipped` to `warnings`. Each file is
self-audited against this list and against the codebase's ideal standard before it is
considered done.

---

## §11 — Evidence index (nothing above is asserted from memory)

- **Phase architecture / orchestration:** `index.ts:122` `runCoreTransform`, `index.ts:222`
  `runPipeline`, `index.ts:270` polish invocation, `index.ts:501` `runHeadless` (no polish);
  `Captured` at `types.ts:28`.
- **Doc/comment conventions:** header template and JSDoc style verified across
  `denoise.ts`, `polish/llm.ts`, `polish/prompts.ts`, `convert/vault.ts`.
- **BYOK broker + vault:** `content/llm.ts:35` `requestLlm`, `NO_KEY` at `:17`;
  `background.js` `LLM_REQUEST`/`llmRequest`/`buildGenerationRequest`, `NON_JSON_REPLY`
  guard and `PROVIDER_MAX_TOKENS`; `convert/vault.ts:52/154` protect/restore;
  `TokenUsage` at `types.ts:248`; model idiom `index.ts:271`, `utils/byok.ts` defaults.
- **Verify oracle:** `standalone.ts:809` `createSizedFrame`, `:837` `zip`, `:475`
  `valuesMatch`, `:196` `probeStandalone`, `:366` `probeEmitted`; `match.ts:75`
  `pairedSubtrees`; `tests/render-diff.mjs` SSIM/pixelmatch/ink; `tests/loop.mjs:24`
  thresholds; `tests/fixtures.mjs:197` determinism check; `tests/verify-state.mjs`
  (forced-pseudo-state fidelity via CDP `CSS.forcePseudoState`).
- **Execution loop / credentials:** OpenRouter provider path in `background.js`
  (`buildGenerationRequest` openrouter case) + default `google/gemini-2.5-flash`
  (`utils/byok.ts`); key staged as the `OPENROUTER_API_KEY` machine env var (never in a
  tracked file), documented in `.env.example`, `.env.*` git-ignored, `RECONSTRUCT-PLAN.md`
  git-ignored to match the `FIDELITY-PLAN*` convention; budget read live from the OpenRouter
  key endpoint `GET /api/v1/auth/key` (confirmed: valid key, `limit: null`, so a dashboard
  cap must be set).
- **Corpus measurements (this investigation):** 23 bundles; non-image code ~14 KB
  (Stripe/Dropbox); Dropbox file 99% base64; 6 `width:100%` vs `inline-size:<rem>`
  conflicts; zero `writing-mode`/real `rtl`; denoise strips 217/229 rules of one prop;
  logical/physical lossless pass ≈ 2.3% of CSS lines.
- **External research:** Design2Code (visual self-revision), ReLook / UI2Code^N (vision
  critic, quality improves per refinement step), screenshot-to-code (recovering
  intent the image/dump does not carry); MDN logical properties (writing-mode mapping) and
  CSS inheritance (form-control font caveat); current model pricing and prompt-caching
  economics (prefix match, ~0.1× reads, 5-min TTL).
