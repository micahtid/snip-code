# RELEASE-POLISH-PLAN: final universal optimizations before release

**Status: M1 through M11 executed and verified Jul 4 2026, uncommitted. Each passed the full
loop: clean build, byte-deterministic fixtures, 23 of 23 pixel backstop, and the state or font
checks its milestone calls for. M12 (real glyph subsetting) is deferred by
decision to a focused follow-up: it is the one milestone that adds a new dependency, a wasm
harfbuzz subsetter plus a woff2 encoder, and the manifest CSP and web-accessible-resource
changes to load wasm in the content script, so it warrants proper dependency vetting and a
security-posture review of its own rather than a rushed integration. Its graceful embed-whole
fallback means deferring loses the tailwind subsetting win but no fidelity. A closing
full-corpus backstop over the M1 through M11 tree passed 23 of 23 with zero failures.**

One correction the execution recorded against the written plan: M9's profiling disproved the
re-mounting hypothesis. Mounting the oracle costs about two seconds across the whole chain; the
real cost is the delta-debugging bisection's per-check style recalc, which reaches the budget on
apple and f1 by their size alone. So the sanctioned shared-oracle plumbing was deliberately not
built, per the plan's own fallback clause, and instead the reset phase now checks each preamble
line against only its selector's subtree, and the BUDGET_MS comment is restored to the truth
that it legitimately caps those two largest bundles with a verified partial result.

This plan lands the last twelve optimizations identified in the Jul 4 release audit. Three
audits fed it: a corpus bloat audit over the regenerated training-data outputs, a source
audit of the minimize and emit layers, and external research on reduction techniques. A
follow-up once-over verified every claim below against the actual source, so each
milestone names the real functions it changes and states its measured evidence up front.

One architectural fact the once-over established, which several milestones lean on: the
minimizer's oracle is a computed-style oracle, not a pixel oracle. It mounts the emitted
document in a hidden iframe, snapshots `getComputedStyle` for every element and painting
pseudo, and accepts an edit only when no computed longhand changed. Equal computed styles
on an unchanged DOM imply an identical render, so acceptance is strictly conservative.
The pixel backstop in the test harness is a second, independent net.

## 1. Ground rules

**Universal, always.** Every change is a rule the pipeline applies to all sites, driven by
ground truth it can measure: textual occurrence, computed values, byte identity, an oracle
verdict. No site tables, no selector allowlists, no magic values shaped to fix one bundle.
A change that cannot be stated site independently does not ship.

**No patchwork.** Each milestone is a small change inside an existing stage, or one new
capability with a single clear home. Nothing bolts a special case on top of the core
algorithm. If a milestone starts sprouting conditionals to protect specific bundles, stop
and root cause instead.

**Not over-engineered.** The smallest correct change wins. No new switches, no parallel
paths, no config surface. Code superseded by a milestone is deleted, not gated.

**Well documented.** Every touched function keeps or gains a comment that states the rule
in plain English and why it is safe. Comments are sentence case and self contained, with
no plan labels. New modules carry a header comment stating their pipeline position.
Self audit each change against the surrounding code before calling it done.

**The feedback loop is the process.** No milestone starts until the previous one passes
the full loop in section 3. A regression anywhere stops the line: root cause it, then fix
or revert, before any new work. One milestone per change set, so every corpus delta is
attributable to exactly one cause.

## 2. Pipeline order, for reference

Interactive states are measured and applied during reconcile, so state rules exist in the
stylesheet before minimize begins. The minimize chain in `src/content/index.ts` then runs
prune, logical folding, normalize, merge, `purgeAtRules`, var inlining plus a second
purge, reset injection, and a closing prune rerun. Milestones below name their stage so
ordering effects are explicit.

## 3. The feedback loop, run after every milestone

1. **Build**: typecheck and bundle must be clean.
2. **Pipeline determinism**: run `tests/run-pipeline.mjs` twice on the corpus. Outputs
   must be byte identical across the two runs.
3. **Pixel backstop**: `tests/minimize-loop.mjs` must stay 23 of 23. The backstop renders
   pre and post minimize documents from the same capture, so it is drift free.
4. **Render neutral fixture**: for milestones that touch emit or markup, snip the local
   `file://` fixture with the old build and the new build and pixel compare. Zero drift
   required.
5. **State verification**: for milestones that touch transitions, states, or variables,
   run `tests/verify-state.mjs` and `tests/forcestate-diff.mjs` on the animated bundles.
6. **Byte ledger**: record per bundle output sizes before and after. Sizes may only go
   down or stay equal. Any increase is a regression to explain.
7. **Regression rule**: on any failure, bisect to the exact rule change, fix the root
   cause or revert the milestone, then rerun the loop from step 1.

Corpus renders are compared within one capture only, since live capture drift swings
scores between runs. Reference images regenerate only via `tests/snapshot-bundles.mjs`.

## 4. Milestones

Ordered so that pure textual CSS changes land first, oracle and performance work second,
asset work last. Dependencies are stated where they exist.

### M1: variable liveness counts reads only

**Evidence**: 32 of 37 `@property` rules across seven audited bundles register names that
no `var()` ever reads. supermemory ships 14 custom property declarations with zero reads.
Source-verified root cause: `motionHeldNames` in `minimize/inline.ts` holds every
`@property` registered name outright, which blocks inlining; the surviving reference then
keeps the registration alive through the occurrence count in `minimize/atrules.ts`. The
hold and the liveness feed each other, so a dead pair can never fall.

**Change**: two tightenings that break the cycle.

- `minimize/inline.ts`, `motionHeldNames`: delete the line that holds every registered
  name. The remaining holds stay exactly as they are: names written inside `@keyframes`,
  names listed in transition or animation values, and names a withheld state rule
  redefines via `addStateRedefinedNames`. Those are the real motion carriers.
- `minimize/atrules.ts`, `nameOccurrences`: count only reads as liveness. A read is a
  `var()` reference or a mention in a transition or animation property list. Writes,
  meaning declarations that set the name, do not keep a registration alive.

Once the hold relaxes, the existing `dropDeadCustomProps` and the second `purgeAtRules`
pass at the inlining step delete the write only declarations and the dead registrations
with no new code.

**Safety**: a variable nobody reads governs no paint. Inlining is verified per batch by
the computed-style oracle and reverted on any change, so a wrong substitution self heals.
The five genuinely consumed registrations in the corpus must survive, which the read
count guarantees.

**Gate**: full loop. Also assert the consumed registrations survive: the tailwind inset
ring and the cluely scale, gradient stops, and leading registrations.

### M2: shorthand covers longhand pruning

**Evidence**: supermemory repeats `border-radius` plus all four logical radius longhands
at the same value inside 21 state rules, about 1.7 KB of pure restatement. State rules
are withheld from prune, so no existing phase can reach these.

**Change**: in the normalize stage, when a declaration block contains a shorthand and a
longhand it expands to, and the longhand value equals what the shorthand implies, drop
the longhand. Implement it generically over the existing shorthand expansion knowledge,
never a named property list. Apply it to withheld state and pseudo rule bodies as well:
the transform is render neutral by CSS definition, so it needs no oracle and the
withhold does not apply.

**Safety**: by CSS definition the shorthand already sets the longhand to that value, so
removal cannot change the cascade result. Order matters: only drop a longhand that
appears after the shorthand in the same declaration block.

**Gate**: full loop, with state verification since withheld rule bodies change.

### M3: sharpen the withheld merge overlap test, and regroup after colorize

**Evidence**: f1 carries 23 separate `:active` rules with byte identical bodies and
supermemory 20 identical focus visible blocks, about 8 KB corpus wide. Source-verified:
`minimize/merge.ts` already merges identical bodies, including withheld rules via
`mergeWithheldRules`, but its `safeToMergeWithheld` test rejects a merge when any
intervening rule targets a shared element at all. Each element's own resting rule sits
between the state rules and always shares the target, so these groups never merge.
Separately, cluely ships two resting rules with byte identical 1.4 KB bodies that only
became identical after colorize unified their colors, which runs after merge.

**Change**: two refinements to the existing stage, no new machinery.

- Refine `safeToMergeWithheld` from element overlap to property overlap: an intervening
  rule blocks the merge only when it shares a target element and declares a property the
  moving body also declares with a precedence the move could flip. Rules that share an
  element but touch disjoint properties cannot interact in the cascade, so they no
  longer veto.
- Run the merge grouping once more after colorize, so bodies that colorize made
  identical collapse too. The rerun reuses the existing merge entry point.

**Safety**: cascade outcome between two rules depends only on properties both declare.
The property level test is exactly that condition. The post colorize rerun is the same
verified transform at a later point.

**Gate**: full loop, with state verification and the animated bundles checked for
unchanged hover behavior.

### M4: strip unreferenced data attributes

**Evidence**: supermemory retains 112 `data-astro-cid-*` attributes with zero CSS
references. Framework scope attributes are a whole class of this.

**Change**: a markup pass at the end of minimize. Collect every attribute name referenced
by any selector in the emitted CSS, then remove `data-*` attributes whose name is never
referenced. Keep everything else, including `aria-*` and functional attributes. The
`data-snip-state` and `data-snip-pseudo` attributes are referenced by their selectors and
survive on their own merit, with no special case.

**Safety**: an attribute no selector matches is inert for rendering. Scoping the rule to
`data-*` keeps semantics and accessibility untouched.

**Gate**: full loop plus the render neutral fixture check.

### M5: transition list folding

**Evidence**: cluely holds 11 enumerated transition declarations totaling 5.9 KB, listing
custom properties and longhands that no state rule ever changes. hoverdev-3 has one 498
byte list where every entry shares the same duration and easing.

**Change**: a normalize stage rule, placed there because state rules are present in the
sheet by minimize time and normalize runs before `purgeAtRules` and var inlining, so M1's
read counting sees the folded lists.

- Drop a transition entry whose property is never changed by any withheld state rule or
  animation, since it can never produce motion. A custom property entry additionally
  requires a read to survive, which M1 establishes.
- After dropping, if every remaining entry shares one duration, easing, and delay, emit
  the grouped shorthand instead of the enumerated list.

**Safety**: a transition entry for a property that never changes value is unobservable.
Folding preserves per property timing whenever timings differ, so the rule that motion
must be smooth in both directions is untouched.

**Gate**: full loop with the state and forcestate checks. Hover timing must stay smooth
on the animated bundles in both directions.

### M6: numeric and color serialization sanity

**Evidence**: cluely prints `border-radius: 2.12676e+37rem` 17 times, the fully rounded
overflow artifact, plus 27 verbose lab and oklch colors the colorize stage left mixed.

**Change**: in the format stage. Clamp a length to `9999px` only where over-large values
saturate, meaning any value at or beyond the saturation point renders identically, and
only when the value exceeds a threshold no real layout can reach. Border radius is the
corpus case. Emit colors in one consistent form chosen by the existing colorize rules
rather than leaking the browser serialization.

**Safety**: the clamp applies only where saturation makes it render neutral by
definition. The color change is serialization form only.

**Gate**: full loop. The colorize backstop must stay green.

### M7: more paint irrelevance relaxations in the oracle

**Evidence**: 36 surviving `text-decoration-color` declarations under `none` lines and 18
`-webkit-tap-highlight-color` survivors corpus wide.

**Change**: extend the per target skip set in `minimize/oracle.ts`, the existing
`paintIrrelevant` mechanism, with four cases judged from reference values exactly like
the shipped relaxations.

- Decoration color, style, and thickness when the decoration line is `none`.
- `-webkit-tap-highlight-color` unconditionally, since it paints only a mobile tap flash
  and never a resting pixel.
- Text stroke color when the stroke width is zero.
- Column rule color and width when the rule style is `none`.

`-webkit-text-fill-color` stays excluded. A prior relaxation of it regressed and was
reverted, and the hover color freeze depends on it surviving.

**Safety**: the gating property is never itself skipped, so any removal that would make
the thing paint still changes a compared value and is caught, the same argument as the
shipped cases. The tap highlight case is the one deliberate trade: a mobile tap flash may
differ from the source site. It is invisible in every resting and hover render the
product verifies, and it is accepted here explicitly rather than slipped through.

**Gate**: full loop.

### M8: grow the reset preamble

**Evidence**: 52 `cursor: pointer` restatements corpus wide, plus repeated link, list,
and button zeroing that a shared preamble would absorb. `minimize/reset.ts` already owns
the mechanism: each line is injected alone and kept only when the computed-style oracle
confirms it changed nothing, and the closing prune rerun deletes the per rule
restatements an accepted line makes redundant.

**Change**: add candidate lines to `RESET_RULES`. Candidates: pointer cursor on links and
buttons, list margin, padding, and style zeroing, link color inherit and no underline,
button background, border, and padding zeroing. Keep lines fine grained, since acceptance
is all or nothing per line and one deviant element vetoes a whole coarse line.

**Safety**: a line ships only when the oracle proves it computed-style neutral for that
snip. Because the oracle compares every computed longhand, this works for non painting
properties like cursor too: deleting a restatement is only accepted once the preamble
supplies the identical computed value.

**Gate**: full loop.

### M9: profile and retire the prune budget on the largest bundles

**Evidence**: the 20 second `BUDGET_MS` in `minimize/prune.ts` is documented as a safety
valve that never fires in practice, but it fires on apple and f1: apple ships 67
`box-sizing` restatements and 216 unresolved `var()` references against a corpus norm of
one and zero. The earlier draft of this milestone proposed a computed style prefilter
before a pixel render; the once-over found the oracle is already computed style based,
so that idea is void. The real question is where the wall time goes.

**Change**: measure first, then fix the measured bottleneck. Instrument stage wall time
and oracle comparison counts on apple and f1. The prime suspect, visible in the source:
every minimize phase mounts a fresh oracle iframe and takes a full reference snapshot of
every element against roughly 350 longhands, and the chain does this seven times per
component. If the profile confirms it, share one mounted oracle across the phases that
operate on the same markup, re-snapshotting the reference between phases instead of
re-mounting and re-reading the world. That is a plumbing change along the existing call
chain, not a new layer. If the profile points elsewhere, fix what it names instead.

Exit condition: apple and f1 complete every phase inside the budget with headroom. Then
keep `BUDGET_MS` as the safety valve its comment already describes, restored to truth.

**Safety**: no verification rule changes, only how often the same snapshots are taken.
Determinism is unaffected because the phase order and comparison logic stay fixed.

**Gate**: full loop, plus a wall time ledger for the five largest bundles, plus
confirmation that apple's restatement and unresolved var counts drop to the corpus norm.

### M10: merge byte identical font faces

**Evidence**: cluely embeds one byte identical woff2 three times, once each for weights
400, 500, and 600, which is 52 percent of its CSS block in the single file form.
Source-verified: `convert/assets.ts` already dedupes split files by content via
`fileByContent`, so the split form pays once, but the single file form and the rule
count pay three times. Duplicate inline images in the single file form, supermemory's
916 KB, are inherent to self contained delivery: an `img` element cannot reference
another element's bytes, and the split form already dedupes them. They are accepted as
the cost of the single file shape, not patched around.

**Change**: in the font resolve path. Hash each embedded face's bytes. When two faces
share identical bytes and every descriptor except weight matches, collapse them into one
`@font-face` whose `font-weight` spans the merged range. This shrinks both delivery
shapes and reads the way a human would write it.

**Safety**: byte identity is the strongest possible equivalence, and the browser resolves
a weight range face for every weight the merged faces served. Faces differing in any
other descriptor stay separate.

**Gate**: full loop plus the render neutral fixture. Font rendering on cluely must be
pixel stable across the merge.

### M11: correct font mime labels

**Evidence**: f1 labels font data uris `data:binary/octet-stream`.

**Change**: in the font resolve path, label every font data uri with its true mime,
`font/woff2` or `font/ttf`, detected from the bytes. Small, standalone, and it keeps the
split file extension honest too.

**Safety**: browsers sniff font bytes regardless, so the label change is behavior
neutral. The fixture check proves it.

**Gate**: full loop plus the fixture.

### M12: real glyph subsetting, emitting woff2

**Evidence**: tailwind ships a 352 KB variable font untouched because the source site
serves no unicode range splits, 93 percent of that file. Source-verified: the pipeline
only selects among splits the site already made, in `resolve/fonts.ts`; it never subsets
glyphs itself. f1 additionally ships three ttf faces at 54 to 57 KB each.

**Change**: the one new capability in this plan, landing last because it is the largest.
In `resolve/fonts.ts`, after face selection, subset each kept face to the exact set of
codepoints the snip renders, including generated content strings, using the wasm
harfbuzz subsetter, and emit the subset as woff2 regardless of the input container. That
folds the ttf to woff2 win into the same step, so no separate transcoder exists. On any
subsetter failure the face embeds whole in its original container, the graceful by
contract fallback.

**Safety**: the snip is a closed document, its glyph set is fully known at emit time, so
a subset covering that set renders identically. Subsetting is deterministic for a given
input, preserving the byte determinism guarantee. The fallback preserves today's
behavior on failure.

**Gate**: full loop plus the fixture, plus a glyph audit: render every corpus bundle and
confirm zero tofu or fallback face substitutions against the same capture render.

## 5. Order of execution and exit

Land M1 through M12 one at a time, full loop between each. After M12, run the loop once
more end to end, record the final byte ledger against the Jul 4 baseline, and update the
plan status line. Expected corpus wins from the audits: about 440 KB on tailwind from
subsetting alone, about 78 KB on cluely from the font face merge, and 15 to 20 KB plus a
large readability gain from the CSS milestones. Nothing in this plan may trade fidelity
for bytes: every milestone is render neutral by construction or oracle gated, the one
explicit exception is the mobile tap flash accepted in M7, and the backstop stays 23 of
23 throughout.
