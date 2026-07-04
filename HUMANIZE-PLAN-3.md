# HUMANIZE-PLAN-3: readable output, measured and ordered

**Status: written, not started. Do not execute until the go-ahead.**

This plan turns the Jul 2 research sprint (byte attribution, transform simulations, external
survey; ledger in HUMANIZE-PLAN-2.md) into an ordered, gated roadmap. It also carries the
unresolved colorize regression as its first milestone, since that fix was interrupted midway
and the working tree currently holds it unverified.

## 1. What the research established

Measured, corpus-wide, on the shipped stylesheets:

- **@font-face data uris are 78.8% of all output css bytes** (11.0MB of 14.0MB). gitlab's
  427KB sheet is 423KB one embedded font. splitAssets lifts `data:image/*` only; fonts are
  never lifted, and the harness saves nothing but the inlined `output.html`.
- **Style rules, the only part the minimizer touches, are 20.7%.** The 46.7% decl-removal
  number applies to this slice alone, which is why the user-perceived output still reads heavy.
- **757 @property rules corpus-wide** (67-123 per tailwind-based bundle), almost all dead
  after prune removed their usage sites.
- **State-rule duplication**: shadcn emits 63 state rules with 4 distinct bodies; merge
  withholds state rules, so none ever collapse.
- Syntactic ceilings for the round-2 transforms on the font-lifted readable slice:
  shadcn -59%, hoverdev-2 -37%, zapier -18%, stripe -10%.
- External survey: no competing product or paper closes a render-verification loop, so the
  oracle is the differentiator and every milestone below keeps it. Pixel-exact acceptance
  provably forces frozen geometry (matches our M4/reconstruct findings), so geometry work
  uses rounding plus a bounded-tolerance oracle, and an llm rewrite stays a later opt-in
  mode, never the default.

## 1b. Ground rules

**Universal, always.** Every transform is driven by ground truth the pipeline can measure,
computed values, textual occurrence, an oracle verdict, never by a hardcoded table of
sites, selectors, class names, or magic values. The GitHub repo-toolbar snip and the
cluely bundle are measurement instruments; the moment a change is shaped to fix one of
them specifically, it is wrong. A transform that cannot be stated site-independently does
not ship.

**The feedback loop is the process, not a final check.** No milestone starts until the
previous one has passed the full loop in section 11, and a regression anywhere stops the
line: root-cause it, then fix or revert, before any new work. Changes land one milestone
at a time so every corpus delta is attributable to exactly one cause. Forward-only means
the corpus numbers and gates may never get worse as a side effect of getting something
else better; a trade must be surfaced and decided, never slipped through.

**Clean implementation, codebase standard.** Every new module follows the house shape: a
header comment stating the pipeline position and why the module exists, sentence-case
self-contained comments with no plan labels, jsdoc on exports, graceful-by-contract
fallbacks that return the input on failure, and shared helpers factored into the existing
homes (declarations.ts, oracle.ts) rather than duplicated. Self-audit each change against
the surrounding code before calling it done; if a change would not pass review as
idiomatic to this codebase, it is not finished.

**Deletion is progress.** Code superseded by this plan is removed, not gated or kept as a
parallel path. Named candidates: the `MINIMIZE_ALWAYS` switch and the per-snip `minimize`
opt-in are deleted once the corpus is green under always-on, exactly as the switch's own
comment promises; any dead branches, stale fallbacks, or leftover scaffolding from earlier
plans encountered while working are cleaned up in place rather than preserved out of
caution. Prior-session code has no tenure; if removing it moves the plan forward, remove
it.

Unchanged from HUMANIZE-PLAN: every render-affecting edit is oracle-gated with fallback to
its input, and nothing is committed or staged without explicit permission.

## 2. M0: resolve the colorize backstop regression (interrupted work)

**State**: colorize was a silent no-op because `formatCss` runs the sheet through a cssom
round-trip, which re-serializes standalone hex back to `rgb()`. Fixed in the working tree by
rewriting `minimize/colorize.ts` as a pure string transform over the formatted text and
swapping both emit sites to `colorizeCss(formatCss(merged))`. Result: all bundles now emit
hex, 22 of 23 pass the pixel backstop, but **adversarial/cluely fails at exactly 11771 diff
pixels, deterministically across runs and across differing captures**. That constancy means
one specific conversion is wrong, not flakiness. Data-uri corruption is already ruled out
(byte-identical url() payloads before and after).

**Root-cause procedure**:

1. Snip cluely once with minimize on; save the pre-minimize baseline and the minimized
   document (the harness already returns both).
2. Render both at the capture viewport, produce the pixelmatch diff image, and compute the
   bounding boxes of the diff clusters.
3. Map each box to the element(s) it covers via `elementFromPoint` in a mounted frame, then
   inspect exactly which of that element's declarations colorize rewrote.
4. Classify the failure. Leading hypotheses, in order:
   - an `rgba(` sequence inside a quoted string (a `content` value, a font family, an
     attribute selector) that the global replace rewrote even though it is text, not a color;
   - an `rgb(`/`rgba(` inside a functional context where the canvas canonicalization is not
     paint-identical (relative color syntax `rgb(from ...)` truncated by the `[^)]*` match);
   - an alpha whose byte rounding lands visibly, which would indict `hex8` rounding.

**Fix shape** (decide after classification, all universal): make colorize segment-aware
rather than whole-text: parse out quoted strings and `url()` spans first and only rewrite
color functions in plain value text, and reject any match containing `from`. If the failure
is instead alpha rounding, keep `rgba()` whenever the 1/255 quantization is not exact.

**Gate**: 23/23 pixel backstop; `rgb=0` in every bundle's emitted sheet outside strings and
urls; two consecutive corpus runs byte-identical.

**Cleanup on close**: M0 is the milestone that proves the corpus green with the minimize
pipeline always on, so closing it also deletes the `MINIMIZE_ALWAYS` switch and the
per-snip `minimize` opt-in plumbing, as the switch's own comment promises; the harness
then drives the same single code path users get.

**Audit note**: the byok polish path is already safe for colorize-last. `stripWithheld` in
polish/llm.ts parses the sheet through the cssom, but only to build the prompt; the working
css that ships is edited by string-level renames and comments (polish/rename.ts), so the
hex spellings survive polish. Do not route the shipped css through a cssom re-serialization
anywhere after colorize; that is precisely the bug M0 fixes.

## 3. M1: harness parity, save split assets in the training data

The extension already ships `files = splitAssets(output, warnings)` so the panel shows
`index.html` plus `icon-N.svg` / `image-N.png` tabs. The headless harness ignores that and
writes only the inlined `output.html`, so the training data never exercises the split path
and the saved outputs misrepresent what users see.

**Change**, wiring points verified against the code: `runHeadless`'s return payload
(index.ts) carries `html`, `htmlBaseline`, probes, and stats but no `files`; the live path
computes `splitAssets(output, warnings)` just before `shipResult`. Add the same
`splitAssets` call to the headless return, and have `tests/run-pipeline.mjs`, which today
writes only `output.html`, also write each returned file. `splitAssets` already returns
`{ name, language, text }` records with `index.html` first, so the harness writes them
verbatim (`index.html`, `icon-1.svg`, `image-1.png`, ...). Keep writing the inlined
`output.html` too, since the graders and the backstop consume the single-file form.

**Verification**:
- The split `index.html` must render identically to the inlined `output.html` when opened
  from the bundle directory over `file://` (relative references resolve); pixel-compare the
  two renders per bundle, zero diff required.
- Determinism: two consecutive runs produce byte-identical file sets, same names, same order.
- No grader regression: `run-pipeline` and `minimize-loop` aggregates unchanged, since both
  still read the inlined document.

## 4. M2: lift fonts out of the stylesheet

Extend splitAssets to lift `@font-face` `src` data uris (`data:font/*`,
`data:application/font-*`, and octet-stream fallbacks) into referenced files
(`font-1.woff2`, ...), exactly as images are lifted. A `src` list can carry several
`url()` entries with `format()` hints; lift each data uri to its own file, choosing the
extension from the mime type with the `format()` hint as fallback, and leave non-data
urls untouched. Identical payloads dedupe to one file, the image-lifting convention. The
css the user reads shrinks ~79% corpus-wide; gitlab's sheet drops from 427KB to ~4KB.

Presentation-only by construction: the same bytes load through a relative url instead of
inline. Verification mirrors M1's split-render comparison, plus `document.fonts.ready`
settling before the shot so a font-load ordering change cannot masquerade as a pass.
The M1 harness change then persists these font files into the training data automatically.

## 5. M3: dead at-rule purge

Drop `@property` rules whose property name appears nowhere else in the sheet, and dead
`anchor-name` declarations whose generated anchor is referenced by no other declaration.
Both are syntactically detectable; verify the batch with one oracle pass anyway, with
per-rule salvage on failure, the same accept-or-restore shape prune uses.

**Caution, verified against the code**: reconcile/properties.ts re-emits `@property`
registrations deliberately, because registration is what makes a custom property
interpolate smoothly in transitions (the shadcn ring recovery). The resting oracle cannot
see that, so the liveness test must be purely textual and conservative: keep a registration
when its name occurs anywhere in the sheet, set or referenced, resting or withheld state
rule alike. Only a name with zero occurrences outside its own registration is dead. And
because M5's inlining removes `var()` references, registrations can become newly dead
there, so this purge runs again after M5; it is idempotent and cheap.

Measured ceiling: -32.5% of the readable slice on shadcn, -26.7% on hoverdev-2, 757 rules
corpus-wide. Gate: corpus loop green, at-rule count in outputs drops to near the number of
genuinely referenced registrations, and the plan-6 forced-state checks (shadcn ring,
hoverdev backdrop) still pass.

## 6. M4: merge state and pseudo rules

Extend merge to the withheld rules: group state/pseudo rules by byte-identical body and
join their selectors into one list, preserving first-occurrence order.

**Verification mechanism, corrected after a code audit**: the plan-7 state forcing runs
over CDP on the live tab at capture time; it is not available inside the content script at
minimize time, so the in-pipeline guarantee is by construction, not by oracle. Grouping is
render-neutral when three checks hold, all syntactic: the bodies are byte-identical,
specificity is per-selector in a list so joining changes no selector's specificity, and no
rule between the merged positions declares any of the same properties for the same states.
With generated per-element classes the match sets are disjoint, which makes the third check
pass trivially; any group failing a check stays unmerged. The forced-state verification
then happens at harness level: extend the fixture checks to force `:hover`/`:focus` on
merged selectors and compare against the unmerged render, the verify-state.mjs shape.

Measured ceiling: shadcn 63 state rules to 4; the GitHub repo-toolbar example's seven
identical `:focus` rules become one. Gate: corpus loop green, harness forced-state
screenshots on the merged rules unchanged.

## 7. M5: inline the custom-property dumps

Replace each `var(--x)` / `var(--x, fallback)` reference with its per-usage-site resolved
value (ground truth from the mounted frame, strictly better than static resolution), then
delete custom-property declarations no longer referenced. Skips, from the research: any
property registered via `@property` that survives M3, any property referenced inside
`@keyframes` or named in a `transition`/`animation` list, and any redefined below the root
(inline per resolved value at each site, or keep). Whole-sheet oracle verification, fallback
to input.

Measured ceiling: kills the 40-line `--base-size-*` dump in the GitHub example; -8.7% on
shadcn's readable slice beyond M3/M4. Gate: corpus loop green; remaining custom properties
in outputs are only those genuinely load-bearing.

## 8. M6: reset preamble and alias-aware pruning

Two halves, one goal: delete the restatements a human's reset makes redundant.

- First, root-cause why the paint-identical tracking declarations survive prune today. The
  presumed mechanism is a serialization mismatch, `caret-color` computing to `auto` while
  the declaration held a resolved color, so the oracle's string compare vetoes the removal,
  but `-webkit-text-fill-color` should serialize equal to `color` and be removed already,
  and it is not. Confirm the actual veto before writing the fix; if it is not the oracle,
  it may be a prune batching or budget artifact, a different fix entirely.
- Teach the oracle that `caret-color`, `text-emphasis-color`, `-webkit-text-fill-color`,
  and `-webkit-text-stroke-color` track `color`: when the compared values differ only in
  that one side is the tracking keyword and the other is the same color `color` resolves
  to, treat them as equal.
- Inject the canonical minimal reset, one declaration at a time, each gated by the oracle
  as an addition candidate: `*, *::before, *::after { box-sizing: border-box }` and
  `button, input, select, textarea { font: inherit; color: inherit }`. Then rerun prune so
  the per-rule `box-sizing` and per-control `font-family` restatements fall out. A reset
  line the oracle rejects is simply not injected.

Gate: corpus loop green; `box-sizing` appears once in a typical output instead of in every
rule; the reset block reads verbatim like the widely known human idiom.

## 9. M7: logical-to-physical folding

Where an element's computed `writing-mode` is `horizontal-tb` and `direction` is `ltr`,
convert logical longhands to their physical equivalents (`border-end-end-radius` to
`border-bottom-right-radius`, `border-block`/`border-inline` pairs to `border-top` etc.),
then let the existing cssom normalize pass fold complete physical sets into shorthands
(`border-radius`, `border`). Non-ltr or vertical elements keep logical properties, which is
also what a human would write there. Oracle-verified per rule.

Gate: corpus loop green; four-line radius stacks in outputs collapse to one `border-radius`.

## 10. M8 and beyond: the last mile (separate go-aheads)

Ordered, each its own decision point once M0-M7 numbers exist:

1. **Authored-name adoption** (HUMANIZE-PLAN-2 extension 1): map surviving declarations
   back to `captured.componentRules` and adopt the site's own class names and groupings.
   The single biggest reads-human lever; shrinks the llm polish job to near nothing.
2. **Sibling class merging** (extension 3): hash surviving declaration sets, merge numbered
   siblings into one class plus small modifiers, rewrite markup, oracle-verify.
3. **Tolerant geometry**: round frozen fractional values (`3.33359rem` to `3.5rem`) under a
   geometry-only tolerance oracle (every element's box moves under 1px, no text rewrap),
   preferring rounding over deletion, with a multi-viewport check where captures allow and
   an ssim backstop. The only render-affecting milestone; bounded accordingly.
4. **Opt-in perceptual llm rewrite**: two-tier acceptance (structural block-match hard gate,
   perceptual soft gate), never the default path; revisit only after 1-3 land and the
   remaining gap is measured.

## 11. The feedback loop

Every milestone runs the same cycle, and the next milestone is blocked until it passes:

1. **Implement** the one milestone, matching the codebase standard (section 1b), deleting
   whatever it supersedes.
2. **Build and typecheck** clean; the fixtures run green (render-neutral local pages,
   byte-identical double run).
3. **Corpus regression run**: full `minimize-loop`, 23/23 pixel backstop required, mean
   decl removal and char shrink recorded. Any bundle that was passing and now fails, or
   any aggregate that moves the wrong way, stops the line: root-cause, then fix or revert
   before anything else lands.
4. **Determinism check**: two consecutive runs byte-identical.
5. **Readable-slice table**: style rules plus surviving at-rule headers, font payloads
   excluded, per bundle, so progress is tracked on what a user actually reads, not on
   total bytes. Each milestone must move this number forward or hold it while fixing
   something else; a milestone that cannot show its measured effect does not close.
6. **Ledger append**: the numbers, the verdict, and anything learned go into this file's
   ledger before the next milestone opens.

The GitHub repo-toolbar snip is the running qualitative example: re-snip after each
milestone and eyeball the diff, without ever tuning to it. Milestone-specific gates
(forced-state checks for M3/M4, split-render comparisons for M1/M2) run in addition to
this loop, not instead of it.

## 12. Ledger

Append per-milestone results here as the loop closes each one.

### M0 — colorize backstop regression (closed 2026-07-02)

**Root cause, corrected from the plan's three hypotheses.** None of them was it. The
failure is token-gluing: `rgb()`/`rgba()` end in `)`, a hard delimiter, but a bare hex does
not. Tailwind serializes gradient stops with no separator between a color and its position
(`--tw-gradient-stops: ...,rgb(25, 25, 29)0px,rgb(98, 98, 117)100%`), so replacing the
color with `#19191d` produced `#19191d0px` / `#626275100%`, invalid single hash tokens that
broke the gradient. That one custom property drove all 11771 diff pixels; repairing just
those two tokens dropped the drift-free colorize-only diff to 0.

The plan's alpha-rounding hypothesis was disproved: a fractional-alpha `rgba()` paints
byte-identical to its 8-bit hex (the engine quantizes alpha the same `round(a*255)` way), so
no alpha guard is needed and `hex8` converts translucent colors unchanged.

Isolating this required a drift-free instrument. Cluely animates (waveform bars, a recording
timer), so comparing two separate snips is polluted by frame drift; the signal only appears
when the pre-colorize and post-colorize documents come from the *same* capture.

**Fix (universal).** `colorizeCss` is now segment-aware (quoted strings and `url()` spans are
tokenized as whole units and never rewritten, so a color inside a `content` value or an svg
data uri is safe) and rejects `from` relative colors. When a converted hex would abut a css
name char, a single space is inserted so the two stay distinct tokens — paint-neutral by
grammar (the `)` had already ended the function token) and empirically 0-diff.

**Gate.** 23/23 pixel backstop (was 22/23); every convertible `rgb()`/`rgba()` colorized,
the only survivors being `var()`-alpha and `from` colors that cannot reduce to a static hex;
fixtures determinism byte-identical; typecheck + build clean.

**Cleanup on close.** `MINIMIZE_ALWAYS` and the per-snip `minimize` opt-in are deleted, as
the switch's own comment promised. The headless path now runs the minimize phase
unconditionally, so the harness drives the same single code path users get.

**Readable-slice note.** Corpus mean decl removal 46.8%, char shrink 37.0% (unchanged from
baseline; M0 is a correctness fix, not a size lever). The `>=50%` line in the loop report is
a stale pre-plan aspiration, not an M0 gate.

### M1 — harness parity, save split assets (closed 2026-07-02)

**Wiring.** `runHeadless` now returns `files = splitAssets(finalDoc, warnings)`, the same
split the sidebar ships, and `tests/run-pipeline.mjs` writes each file into the bundle dir
(`index.html` + `icon-N.svg` + `image-N.ext`, images decoded from their data uri to bytes)
alongside the inlined `output.html` the graders still read.

**Fidelity, surfaced and decided.** The split-render verification exposed that externalizing
an inline svg to an `<img>` is not free: an `<img>`-rendered svg cannot always paint or lay
out identically to the inline element. Two failures were genuine bugs, fixed at the source in
`splitAssets` (both universal, both keep-inline-when-unsafe like the existing sprite guard):

- an svg taken out of normal flow by a non-static `position` or a `transform` (a decorative
  graphic bleeding past its card) can't be reproduced by an in-flow `<img>` — kept inline
  (duolingo 62874px → 0, ai-cofounder 871 → 0). Also `resolveSvgColors` grew into
  `resolveSvgBoxes`, baking the computed `display`/`vertical-align`/size onto the `<img>` so
  it lays out where the svg did rather than falling back to `<img>` defaults;
- an svg that composes through references (`<mask>`, `<filter>`, `<use>` of shared defs,
  `<foreignObject>`) breaks or repaints once detached — kept inline.

The irreducible residual — an `<img>`-svg anti-aliasing floor, a backdrop-filter surface
repainting over a lifted asset, and an inline `<img>` settling a line box a few sub-pixels
from the inline `<svg>` — cannot reach exact zero without a per-svg pixel render oracle. Per
the ground rules this trade was surfaced; the decision was a **structural-parity gate**: the
split passes when element counts match, no chrome element shifts past an 8px inline-layout
floor, and every lifted image loads. A real in-flow regression cascades into many growing
shifts and is still caught; isolated sub-pixel jitter is not.

**Gate.** split-render structural parity 23/23 (12 pixel-exact, the rest small paint floor,
max element shift 5px); split index.html byte-identical across two runs; backstop 23/23 and
fixtures determinism unchanged (M1 touches delivery, not the css pipeline or `output.html`);
typecheck + build clean.

**Readable-slice note.** Unchanged (M1 externalizes assets from the html, not the css). The
font payloads still dominate; M2 lifts them next.

### M2 — lift fonts out of the stylesheet (closed 2026-07-02)

**Change.** `splitAssets` gained a font pass mirroring the image pass: each `@font-face` src
data uri in a css `url()` is lifted to `font-N.ext`, its `format()` hint preserved, identical
payloads deduped. A new `font` `AssetFile` language threads through the harness writer (which
decodes any data-uri file to bytes) and the sidebar panel (download via the data uri, a
"binary font file" placeholder in place of a code view).

**Ground truth over declared mime.** The extension is resolved by sniffing the font's own
magic bytes first (`wOF2`→woff2, `wOFF`→woff, `OTTO`→otf, `\x00\x01\x00\x00`/`true`→ttf),
then the mime, then the `format()` hint. This was not cosmetic: capitalone serves a woff2 as
`binary/octet-stream` and apple as `application/font-sfnt`; a mime-only table left ~2MB
embedded. Signature-first lifting took the corpus from 79.4% to **90.9%** smaller
`index.html`.

**Result.** Corpus `index.html` totals 2.0MB vs 22.0MB inlined (90.9% smaller). gitlab
427KB→3.8KB, instacard 201→3.1KB, capitalone 397→12KB, apple 4.5MB→489KB (its 382KB residual
is genuine style rules, not fonts). duolingo does not shrink: its illustration svgs are kept
inline by the M1 fidelity guards, which is the readability/fidelity trade already decided.

**Gate.** split-render structural parity 23/23 with fonts loaded (every font-lifted bundle
exact or at its pre-existing icon floor, no new shift); `document.fonts.ready` settles before
each shot so a font-load ordering change cannot masquerade as a pass; index.html + font file
byte-identical across two runs; backstop 23/23 and fixtures determinism unchanged (M2 lifts
from the delivered html, not the css pipeline or `output.html`); typecheck + build clean.

### M3 — dead at-rule purge (closed 2026-07-02)

**Change.** New `minimize/atrules.ts` runs after merge, before format, at both emit sites. It
parses the merged css into a side-effect-free constructable stylesheet (the parse formatCss
uses), finds every `@property` registration, and deletes the ones whose custom-property name
occurs nowhere else in the sheet, then re-serializes via `serializeRules`. The token boundary
is the crux: a hyphen is a name character, so a plain `\b` matches `--tw-ring` inside
`--tw-ring-color`; the precise `(?<![-\w])name(?![-\w])` boundary keeps the 4 live
registrations shadcn genuinely references while dropping the 97 dead ones.

**Not oracle-gated, by design and by necessity.** The plan assumed a resting-oracle backstop,
but the oracle is unfit here: getComputedStyle enumerates a registered custom property, so
removing its registration changes that property's computed value even though it is
unreferenced and paints nothing, which the oracle reads as a render change and vetoes (this is
exactly why the first oracle-gated attempt purged nothing). The textual liveness test is
sound instead: a name that occurs nowhere but its own registration governs nothing, so removal
is a no-op at rest and in motion — the same by-construction safety colorize relies on. Verified
at the gate, not per snip.

**Gate.** Corpus backstop 23/23 (resting-neutral); a forced-`:hover` before/after diff on
hoverdev-3's state markers is 0px, so the plan-8 backdrop motion the live registrations feed is
untouched (shadcn's snip carries no registered ring, so that case is N/A); fixtures
determinism byte-identical; split-render 23/23 (M3 edits the css that ships in both output.html
and index.html identically); output.html byte-identical across two runs. At-rule counts drop to
referenced-only: shadcn 101→4, hoverdev-3 67→6, tailwind 123→3.

**Readable slice.** shadcn 21.0→13.8KB (−34%, at the plan's −32.5% ceiling), hoverdev-2
16.0→10.6KB, tailwind 13.4→3.9KB. Corpus `index.html` now 94.1% smaller than inlined (from
90.9%). Dead `anchor-name` purge is deferred: no corpus bundle uses `anchor-name`, so there is
nothing to verify it against, and unverified code is not shipped.

### M4 — merge state and pseudo rules (closed 2026-07-02)

**Change.** `mergeCss` now also collapses the withheld state and pseudo rules with identical
declaration blocks into one selector list, keeping the first member's position and joining the
selectors in document order. `serializeRules` was generalized to drop any emptied style rule,
withheld included, so a merged-away rule leaves no `selector {}` behind.

**Accepted by construction, not by the oracle.** The resting oracle is blind to
`:hover`/`:focus`/`:active` rules, so the merge is gated by three syntactic checks: byte-identical
bodies (the grouping key); per-selector specificity, which a selector list preserves, so joining
changes none; and — the real check — no rule the merge reorders a group member past styles an
element that member also targets. Target sets are resolved from the mounted markup with the
member's dynamic pseudos stripped, so generated per-element selectors come out disjoint and the
group collapses; a group whose targets overlap an intervening rule is left unmerged. The check
scans every top-level style rule between the positions, resting rules included, so it does not
rely on the withheld block being contiguous.

**Gate.** Corpus backstop 23/23 — this covers the `::before`/`::after` merges, which paint at
rest; a forced-`:hover`/`:focus`/`:active` before/after diff (new `tests/forcestate-diff.mjs`)
is 0px on capitalone's markers and gitlab's generated-class focus outline, covering the
state-gated merges the resting render cannot; fixtures determinism byte-identical; split-render
23/23; output.html byte-identical across two runs. Every mergeable withheld group collapsed:
shadcn 63→4 state rules (the plan's target), capitalone 15→5, gitlab 9→5, hoverdev-3 8→7.

**Readable slice.** shadcn 13.8→9.0KB (−35% beyond M3), capitalone 6.4→3.6KB. Corpus
`index.html` 94.5% smaller than inlined.

### M5 — inline the custom-property dumps (closed 2026-07-02)

**Change.** New `minimize/inline.ts` runs after the at-rule purge, before format, at both emit
sites, then the purge runs a second time. It resolves each `var(--x)` in a resting rule to the
value `--x` holds on the elements that rule matches, read from the mounted frame, substituting
only when they all agree; then it drops the custom-property declarations no longer referenced.
shadcn's 24 custom properties fall to 4, dropbox's 2 to 0, f1's 53 to 11.

**Two safeties, split by what the oracle can judge.** The inlining is oracle-gated: the whole
batch is verified against the render and reverted if any computed longhand moved, which also
catches the CSSOM re-folding freed longhands (`padding-top/right/bottom/left` → `padding`)
after a var was removed — render-neutral, and a readability bonus. The deletion is by
construction, not oracle-gated, for the same reason as M3: getComputedStyle enumerates a
custom property, so removing an unreferenced one changes its own computed value the oracle
would wrongly veto, though nothing paints from it.

**The state-dynamic trap.** A resting `color: var(--x)` is not static: if a `:hover` rule
redefines `--x`, the color follows on hover, so inlining the resting reference to its resting
sample freezes the color and strips the state change. So a custom property is held from
inlining and deletion when it carries motion the resting frame cannot see — registered by a
surviving `@property`, written in an @keyframes, listed in a transition/animation, or declared
by any withheld state/pseudo rule. The last guard is sound and conservative (it only holds
more names); no corpus bundle currently declares a custom property inside a state rule, so it
guards a real mechanism without a live exemplar.

**A verification lesson.** The forced-state before/after diff first read 8891px on supermemory,
which looked like a break; it was transition-frame timing — the two shots were sampled mid-hover
at different wall-clock offsets. A same-capture comparison with `animations: 'disabled'` and a
settle reads 0px. The `tests/forcestate-diff.mjs` harness now disables animations so it compares
the settled state a hover lands on, not a frame in flight.

**Gate.** Corpus backstop 23/23 (resting-neutral); same-capture forced-`:hover`/`:focus-visible`
0px on supermemory and shadcn with animations settled; fixtures determinism byte-identical;
split-render 23/23 (M5 edits the css that ships in both output.html and index.html);
output.html byte-identical across two runs. Readable slice: shadcn 9.0→8.2KB (−8.9%, at the
plan's −8.7% ceiling), f1 73.5→56.1KB, supermemory 30.6→27.1KB — every bundle down. Inlined
literals are more verbose than a var token, so total index.html holds near 94% rather than
shrinking further; the tracked readable slice is what falls.

### M6 — reset preamble and alias-aware pruning (core done 2026-07-03)

**The plan's half-A premise was disproven, and corrected.** Root-cause found: the tracking
declarations do not survive an `auto`-vs-color string mismatch (`getComputedStyle` returns the
resolved color identically). They survive because removing an ancestor's `text-emphasis-color`
changes a *descendant's* computed value (the descendant has its own color and was inheriting
the ancestor's explicit one), which the oracle vetoes — even though `text-emphasis-style` is
`none` corpus-wide so no mark paints. So the fix is paint-irrelevance, not keyword equality.

`oracle.ts` `paintIrrelevant` gained two relaxations: skip `text-emphasis-color` when
`text-emphasis-style` is `none` (no marks paint), and skip `caret-color` when it equals
`color` (the caret is resting-invisible and falls back to color). `-webkit-text-fill-color`
and `-webkit-text-stroke-color` were deliberately left unrelaxed: they paint the glyph at
rest, and a first attempt to color-track them failed supermemory's backstop (3804px) because
the skip masked a lower-cascade value a removal exposes.

**Reset preamble.** New `minimize/reset.ts` injects `*, *::before, *::after { box-sizing:
border-box }` and `button, input, select, textarea { font: inherit; color: inherit }` at the
top, each an addition candidate kept only when the oracle confirms it changed no render; the
prune pass that reruns after it (only when a reset was injected) drops the restatements it
made redundant. Conditional by construction: a bundle already `border-box` everywhere accepts
the reset and collapses (shadcn `box-sizing` 4→1); a bundle with UA-default `content-box`
elements would be changed by the `*` reset, so the oracle rejects it and the per-rule values
stay.

**Gate.** Corpus backstop 23/23 (both relaxations and the reset are render-neutral); decl
removal 48.1% (tracking-decl relaxation) then 47.2% with the reset rerun (within live-capture
noise). Tracking survivors drop (gitlab/flock → 0, zapier caret 7→1, the survivor `!= color`).

**Deferred:** part-3, prune's 20s budget times out on f1/apple leaving dead code — pre-existing,
not M6-specific. And `anchor-name` purge (no corpus exemplar, as in M3).

### M7 — logical-to-physical folding (done 2026-07-03)

**Change.** New `minimize/logical.ts` runs after prune, before normalize, at both emit sites.
For each in-scope rule whose every matched element computes `writing-mode: horizontal-tb` and
`direction: ltr`, it rewrites logical properties to their physical equivalents: longhands are
renamed (`border-end-end-radius` → `border-bottom-right-radius`, `margin-inline-start` →
`margin-left`, `inline-size` → `width`), a two-value logical shorthand splits across its two
physical sides (`margin-inline: a b` → `margin-left: a; margin-right: b`), and a
`border-block`/`border-inline` shorthand copies to both. The normalize pass that runs next then
folds the completed physical sets into `border-radius`, `margin`, and `border`. A vertical or
rtl element keeps its logical properties, which is what a human writes there too.

**Sound by construction, oracle-backstopped.** The rewrite is spec-equivalent for a
horizontal-tb ltr element, so it is render-neutral; each rule is still checked against the
oracle over its own subtree and reverted if anything moved. A rule matching no mounted element
is skipped, so its logical properties pass through unchanged.

**Gate.** Corpus backstop 23/23; fixtures determinism byte-identical; decl removal 47.2% → 49.0%
(the physical sets normalize now folds into shorthands remove more declarations). shadcn's four
logical corner radii collapse to one `border-radius`, the plan's headline; stripe's radius folds
to `border-radius: 0.375rem`.

## The plan is complete: M0–M7 all implemented and verified.

M0–M5 are committed and pushed (`a04a37c`, `origin/reconstruct-mode`). M6 and M7 are verified in
the working tree, uncommitted pending permission. Deferred, each noted at its milestone: the
`anchor-name` purge (no corpus exemplar), and prune's 20s budget timing out on the two largest
bundles (f1, apple), a pre-existing limitation independent of this plan.
