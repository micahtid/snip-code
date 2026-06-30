# Migration plan: Colors, Fonts, Assets, and Style JSON (page-scoped inspectors)

Status: **plan only, not started.** No code is written until there is an explicit go-ahead.

This document is the source of truth for bringing four v1 inspector features into the v2
(new) codebase. They are **four co-equal categories**: **Colors**, **Fonts**, **Assets**,
and **Style JSON**. Colors is a first-class category in its own right, not a sub-part of
Style JSON or of Assistive mode. The document is written to be implemented by someone who
has never seen v1: every new file, message, and UI change is named and justified, and
every v1 source file the work derives from is cited.

**Guiding principle (read this first).** These four features already worked well in v1.
This migration is **not** a redesign: behavior, outputs, and heuristics are preserved. The
only goal beyond a faithful port is to make the code **clean, readable, and digestible** —
idiomatic v2 structure, clear module boundaries, good comments. Do not over-engineer, do
not add dependencies, do not change output formats, do not "improve" working logic. The one
unavoidable change is mechanical: v1's AI step ran through a hosted server that no longer
exists, so it routes through the existing BYOK broker instead (§5), kept as minimal as the
`polish` path already is.

---

## 1. What we are migrating, and the one hard truth about it

v1 (`C:/Users/micah/OneDrive/Desktop/snip-code/chrome-extension`) shipped these four
inspector features, each a **whole-page** capture mode with its own button. All four are
co-equal categories in this migration:

| Feature | v1 source | v1 output |
|---|---|---|
| Colors | `src/content/colors/color-extractor.ts` | every color the page uses, perceptually clustered (Oklab), with usage counts and css variables; AI assigns semantic roles (primary/secondary/etc) |
| Fonts | `src/content/fonts/font-extractor.ts` | a list of every font family the page renders, with variants, web/system origin, usage count, `@font-face` URLs, load state |
| Assets | `src/content/assets/asset-extractor.ts` | every image / svg / video / favicon / css background, with type, filename, mime, dimensions, thumbnail |
| Style JSON | `src/content/schema/*` (~2,400 lines) | a compressed **design-system schema** of the whole page: color/spacing/type tokens, a deduped style map, a structure tree, and component blueprints (buttons, cards, nav, sections) |

Colors stands on its own as a category (it is not a sub-part of Style JSON's color
tokens). It earns first-class status because the new README already promises a colors
panel, and it shares the card-grid shape of fonts/assets and the same BYOK AI pass as
Style JSON.

**The hard truth:** these cannot be copied over. They are *page-scoped* and two of them
(Style JSON, Colors) were only good *after* a **hosted server** AI pass
(`/api/schema`, `/api/colors`, `idToken` login, credit accounting). The v2 codebase
deliberately deleted all of that: no backend, no account, BYOK only. So "migrate" means
**re-implement the algorithms cleanly to v2's conventions, and move the AI step from a
server onto the existing BYOK client.**

---

## 2. Locked decisions (from the product owner)

1. **Scope: page-scoped.** Each feature scans the whole page, independent of any element
   snip. They are a standalone "inspect this page" toolset that lives alongside Snip /
   Assistive, not tabs on a snip result.
2. **AI on Style JSON + Colors.** Both get an optional BYOK AI pass (schema synthesis;
   semantic color roles). Fonts and Assets stay raw local extraction. **No key → raw
   local output** (graceful skip, exactly how `polish/llm.ts` already behaves).
3. **UI: modes in the picker's chevron menu.** The `ui` branch's `Picker` is a split
   button with a chevron popover that currently lists Snip / Assistive. The four new
   inspectors (Colors, Fonts, Assets, Style JSON) become additional entries there.
4. **Base this branch off `ui`.** See §3.

---

## 3. Prerequisite: re-base `features` onto `ui`

Today the `features` worktree sits at `e3fdb0d` (`improvements` HEAD). The mode popup,
icon nav, `ViewLayout`, and the redesigned `Picker`/`ResultPanel`/`global-css` live on
the **`ui` branch** (`aaeb251`). The plan targets the `ui` UI, so step 0 is:

```
# from the features worktree, with a clean tree and explicit go-ahead:
git reset --hard ui        # or: rebase the (currently empty) features branch onto ui
```

**Flag — known divergence.** `ui` branched before the recent fidelity work on
`improvements` (standalone reconciliation, inline resources, settle, font-resolution
rewrites, escaped-gradient recovery, overlay fixes). Re-basing `features` onto `ui`
therefore builds on a tree without that work.

**Why that is acceptable for this plan:** every file added here is *page-scoped* and
touches **none** of the element-fidelity pipeline (`reconcile/*`, `resolve/*`,
`convert/*`, `standalone.ts`, `inline.ts`, `settle.ts`). The inspectors read the live
DOM directly and emit their own results. So this feature work and the fidelity work are
orthogonal and can be reconciled later by whoever merges `ui` and `improvements`. That
reconciliation is **out of scope** for this document; it is a separate decision the
owner makes when merging branches.

This step is **not executed as part of planning.** It runs only on go-ahead.

---

## 4. Architecture: a new `inspect/` subsystem

v2 organizes `src/content/` into pipeline phases (`capture → reconcile → resolve →
convert → polish`) plus a sibling `assistive/` directory for the element-scoped JSON
mode. The page-scoped inspectors are a **second sibling**: they do not run the element
pipeline, so they get their own directory rather than being wedged into a phase.

```
src/content/inspect/
  types.ts            InspectResult union + FontReport / AssetReport / ColorReport;
                      re-exports PageSchema from ./schema/types
  fonts.ts            page-wide font extractor      (port of v1 fonts/font-extractor.ts)
  assets.ts           page-wide asset extractor     (port of v1 assets/asset-extractor.ts)
  colors.ts           page-wide color extractor     (port of v1 colors/color-extractor.ts)
  ai.ts               BYOK AI pass for schema + colors (mirrors polish/llm.ts)
  prompts.ts          the schema + colors AI prompts
  schema/
    extract.ts        SchemaExtractor: DOM walk, token collection, blueprints
                      (port of v1 schema/schema-extractor.ts, decomposed)
    classify.ts       element role classifier        (port of v1 schema/dom-classifier.ts)
    fingerprint.ts    style fingerprint + abbreviations (port of v1 schema/style-fingerprint.ts)
    optimize.ts       schema optimizer / caps / dedup  (port of v1 schema/schema-optimizer.ts)
    types.ts          PageSchema + all sub-types        (port of v1 schema/types.ts)
```

This mirrors the existing `assistive/` sibling exactly (a small flat module per concern,
a `types.ts` holding the contracts) and the phase-subfolder style of `content/`.

### Conventions every new file must follow (non-negotiable)

These are the house rules already enforced across v2; the migration matches them so the
result is indistinguishable from existing code:

- **File header block** in the `assistive/*` style: `Pipeline position`, `Reads from`,
  `Writes to`, `Principles applied`, and a `Why this exists` paragraph. Inspectors do not
  touch `Captured`, so the header is honest about what they actually read: "Pipeline
  position" reads `inspect (page-scoped; reads the live dom directly, does not run the
  element pipeline)`, and instead of `Reads from Captured` it reads
  `Reads from DOM: document/window (live; page must be loaded)` and `Writes to: nothing
  (pure extraction, no side effects)`. Do not write "Reads from Captured: n/a" — it hides
  the real live-DOM dependency.
- **Disambiguated function names.** There are already `assistive/{colors,fonts,assets}.ts`
  (element-scoped) and `reconcile/features/colors.ts` / `resolve/fonts.ts`. The new
  page-scoped extractors live at `inspect/{colors,fonts,assets}.ts` and must export
  scope-explicit names so an import is unambiguous at the call site:
  `extractPageColors()`, `extractPageFonts()`, `extractPageAssets()`,
  `extractPageSchema()`. The folder (`inspect/`) signals page scope; the function name
  repeats it so a half-read import is never mistaken for the assistive equivalent.
- **Inline styles + `theme.ts` + injected `global-css.ts`. No `.css` files.** Interactive
  states (hover/focus) go in `global-css.ts` as `sc-*` classes; layout/spacing stay
  inline; shared values come from `theme.ts`. (See `Tasks/TASKS.md` "Styling approach".)
- **Comments**: sentence case, self-contained, no plan labels (no "Step N", "Phase",
  "P1–P5"). No em dashes in executable code.
- **Universal, never example-specific.** The schema heuristics must work on any site; no
  hardcoded per-site CSS tables or tuning to a debug page.
- **Never throw across a boundary.** Each inspector isolates its own failures into a
  `warnings: string[]` and still returns a (possibly partial) result, the same contract
  the pipeline's `runFeatures` uses.

### Repackage for readability, do not rewrite the logic

v1's `schema-extractor.ts` is 1,773 lines in one file with inline color math, a
stratified DOM walk, and ~15 blueprint detectors. It worked; it was just hard to read. The
migration's only schema goal is **digestibility**: split that one file into the few
clearly-named modules above, give each the standard header/comment conventions, and name
functions for what they do. The *algorithms are preserved verbatim in behavior* (Oklab
color clustering, modular-scale fitting, fingerprint dedup, the section/button/card/nav
detectors) — this is a faithful port, not a redesign. The only things dropped are genuinely
dead weight that cannot come over anyway: the `_archive/` cruft, and the server / `idToken`
/ credit-confirm code (replaced by the BYOK broker, §5). Do not drop or "improve" working
detectors; if one is hard to read, make it readable, do not delete it.

### Relationship to current v2 code: reuse, change, drop

**Know the overlap.** v2 already ships element-scoped extractors in
`src/content/assistive/` — `extractFonts`, `extractColors`, `extractAssets` — that walk a
*picked element's* subtree and return lightweight data (family names, color values, asset
urls) for the assistive JSON. The new inspectors do a *related but distinct* job: they walk
the *whole page* and return the *richer* records v1's panels showed (font variants +
web/system + usage count; color swatches + roles; asset thumbnails + type + dimensions).
Because both the scope (element vs page) and the output (bare strings vs rich records)
differ, they stay **separate modules** — merging them would force one to carry the other's
baggage, and the disambiguated names (`extractPageColors` vs assistive's `extractColors`)
keep that clear. **Share only the trivial, already-proven helpers**, not the whole walk:
the URL-absolutization helper that already exists in `assistive/assets.ts` is lifted to one
small shared util and used by both, rather than re-implemented. Do not build a grand unified
extractor; that is the premature abstraction the Guiding principle warns against.

**Do differently from v1 (v2's patterns), behavior unchanged:**

| v1 did | v2 does instead | why |
|---|---|---|
| `class FontExtractor { constructor(log){} async extract() }` | plain `export function extractPageFonts(): FontReport[]` | v2 has no extractor classes; `assistive/*` are plain functions |
| injected `log` callback threaded through every method | the shared `utils/log.ts`, or nothing | drop the constructor-logger ceremony |
| pass results by writing `chrome.storage.local` (`fontData`/`colorData`/…) + panel polls `storage.onChanged` | ship one `INSPECT_RESULT` message; panel listens like it does for `SNIP_RESULT` | storage-as-a-bus is indirection v2 does not use |
| a full-width "Capture" button per mode | a mode entry in the picker's chevron menu | the agreed UI (§7) |
| server AI (`/api/schema`, `idToken`, credits) | the BYOK broker (§5) | no backend exists in v2 |
| carried `extractionTime`, `totalElements`, debug fields | drop them | the UI never renders them |

**Do NOT carry forward at all:** the hosted-server calls and `idToken` auth, the
credit-accounting and the `window.confirm` credit modal, the `_archive/` directories, and
any `FontInfo`/`AssetInfo`/schema field the panel does not render. None of these are
behavior; they are dead weight or belong to the architecture v2 deleted.

**Stays identical:** the results the user sees — the same fonts, assets, colors, and schema
content. That is the line. The *plumbing and packaging* change to fit v2 and read cleanly;
the *feature* does not.

---

## 5. The BYOK AI pass (the "is this a lot of work?" answer: no)

There is **no server to build.** v2 already ships a complete BYOK LLM client that runs on
every snip:

- `public/background.js` `llmRequest()` reads the user's key from
  `chrome.storage.local`, calls the provider directly (OpenRouter / Anthropic / OpenAI /
  Google, all four wired), and returns the reply. Triggered by the `LLM_REQUEST` message.
- `src/content/polish/llm.ts` is the reference orchestrator: build prompt → send
  `LLM_REQUEST` → parse → apply, ~100 lines, with a clean "no key = silent skip" path.
- `src/utils/byok.ts` holds default models and key validation; `SettingsView.tsx` already
  has the provider/key UI; the manifest already whitelists the four hosts.

**The only plumbing change** is that the broker's reply parser is currently hardwired to
polish's shape:

```js
// public/background.js, llmRequest():  return parseReply(text)  ->  { renameMap, hoverRules }
```

Generalize it so the broker returns **raw model text** and each caller parses its own
shape:

- `public/background.js`: `llmRequest` returns **`{ text, usage }`** (raw model text plus
  the token-usage object the session counter already consumes), not the polish-shaped
  `{ renameMap, hoverRules }`. Keep the empty/non-JSON guards that already throw
  `EMPTY_COMPLETION` / `NON_JSON_REPLY`. Delete `parseReply` from the worker. Returning
  `usage` raw is required: the `ui` branch feeds `SNIP_RESULT.usage` into the session
  token counter, so both polish and inspect callers must forward it unchanged.
- `src/content/polish/llm.ts`: move the existing `parseReply` (`{ renameMap, hoverRules }`)
  here so polish parses its own reply, then forwards `usage` as today. Behavior is
  byte-identical; this is a pure refactor and is worth a fixture test (same model text in →
  same `{ renameMap, hoverRules }` out).
- `src/content/inspect/ai.ts`: new orchestrator. Two entry points,
  `enhanceSchema(schema, provider, model)` and `enhanceColors(colors, provider, model)`.
  Each builds its prompt (`inspect/prompts.ts`), sends `LLM_REQUEST`, parses its own JSON,
  forwards `usage`, and merges the AI result onto the raw extraction (schema synthesis;
  `role` per color). Missing key → return the raw input unchanged with no warning, exactly
  like polish.

**The `LLM_REQUEST` payload gains an optional `max`.** Define the shape explicitly
(today it is only implied by the `background.js` handler): `{ provider, model, prompt,
max?: number }`. `background.js` defaults `max` to 2000 (polish omits it); inspect calls
raise it for schema synthesis. **Clamp `max` to the provider ceiling inside
`buildGenerationRequest`** — the broker is the only place that knows the provider, and an
over-large `maxOutputTokens` is a hard 400 on some providers.

**Keep it as simple as polish.** `inspect/ai.ts` mirrors `polish/llm.ts` exactly: build
prompt, await the broker, apply, skip silently on no key. No double-ship, no
`AbortController`, no "enhancing…" state machine — polish has none of that and works fine.

The one thing to watch (do not pre-build for it): a large schema prompt against a slow
model could, in theory, outlast the MV3 service worker (~30s) and leave the request hanging
([service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)).
If testing actually shows a hang, the minimal fix is a timeout that degrades to the raw
output. Until it does, do not add the guard — keeping `optimize.ts`'s existing caps (which
already bound the prompt) is the simpler defense, and it is the behavior v1 shipped.

Net new/changed for AI: ~30 lines in `background.js` (raw text + usage + optional max), a
moved function in `polish/llm.ts`, and `inspect/ai.ts` + `inspect/prompts.ts` (~150 lines
total). No backend, no accounts.

---

## 6. Message protocol and data flow

The inspectors run in the **content script** (they need live-DOM access, which the
content script already has). The flow mirrors the existing picker flow
(`SNIPCODE_START_PICKER` → run → `SNIP_RESULT`):

1. **Trigger.** The panel's `Picker` sends a new ui-local signal to the active tab:
   `SNIPCODE_START_SCAN` with `{ scan: 'fonts' | 'colors' | 'assets' | 'schema' }`.
   `SNIPCODE_START_SCAN` and `INSPECT_RESULT` are **ui-local signals, not members of the
   `MessageType` union** in `types.ts` (the union is only for the request/response
   `Envelope` broker calls). They follow the existing `START_PICKER` / `SNIP_RESULT`
   pattern. Lift both new strings to exported consts shared by `content/index.ts` and
   `Picker.tsx`/`App.tsx` (the existing picker currently hardcodes its string in two
   places; do not repeat that — a single typo silently drops the message).
   **Do not pre-build an ensure-injected guard.** The content script is declared on
   `<all_urls>`, so it is already present on every normal page (the picker relies on exactly
   this today). Only if a real no-receiver failure shows up in testing, add the minimal
   fix then (try the message, on failure `chrome.scripting.executeScript({ files:
   ['content.js'] })`, retry once). Building it upfront is insuring against a ghost.
2. **Run.** `content/index.ts` gains `runScan(scan)` (using the scope-explicit names
   from §4):
   - `fonts`  → `extractPageFonts()`   from `inspect/fonts.ts`
   - `assets` → `extractPageAssets()`  from `inspect/assets.ts`
   - `colors` → `extractPageColors()`  from `inspect/colors.ts`, then (if a key is set)
     `enhanceColors(...)` from `inspect/ai.ts`
   - `schema` → `extractPageSchema()` + `optimizeSchema()` from `inspect/schema/*`, then
     (if a key is set) `enhanceSchema(...)`

   The AI step (colors/schema) runs inline before the single `INSPECT_RESULT` ship,
   mirroring how `polish` runs inline in a snip; it is skipped silently when no key is set
   (§5). `aiEnhanced` on the payload records whether it ran.
3. **Ship.** Send `INSPECT_RESULT` with a discriminated `InspectResult` payload (a new
   ad-hoc result message, sibling to `SNIP_RESULT`; like `SNIP_RESULT` it is not part of
   the `Envelope`/`Response` broker union in `types.ts`).
4. **Render.** `App.tsx` listens for `INSPECT_RESULT` and routes the payload to
   `InspectPanel` (see §7).
5. **AI sub-calls** reuse `LLM_REQUEST` through the background broker (§5). They never
   reach a provider from the content script directly (page CSP forbids it), matching
   polish.

`InspectResult` (in `content/inspect/types.ts`) is a tagged union:

```ts
type InspectResult =
  | { kind: 'fonts';  fonts: FontReport[];  warnings: string[] }
  | { kind: 'assets'; assets: AssetReport[]; warnings: string[] }
  | { kind: 'colors'; colors: ColorReport[]; aiEnhanced: boolean; warnings: string[] }
  | { kind: 'schema'; json: string; aiEnhanced: boolean; warnings: string[] };
```

`FontReport` / `AssetReport` / `ColorReport` are the v2-named, trimmed equivalents of v1's
`FontInfo` / `AssetInfo` / color cluster (drop v1 fields the UI never reads).

**Assets payload must carry URLs, not inlined thumbnails.** A media-heavy page can produce
dozens of assets; base64-inlining each thumbnail into the `INSPECT_RESULT` message would
serialize multi-MB JSON synchronously on both ends (a CPU/jank spike, occasionally near the
messaging size ceiling). `AssetReport` therefore carries the original `src`/URL, and the
asset cards render the preview with a plain `<img src=…>` (the side panel may load remote
URLs directly). Bytes are only fetched/inlined on the explicit download action. Inline SVGs
are the exception (no URL): their serialized markup rides in the report, already truncated
for the thumbnail as v1 did.

**Headless test bridge (defer).** `content/index.ts` already exposes a `snip-runner:snip`
custom event for the grader. These inspectors are simple and already proven, so a manual
smoke test (§11) is the expected coverage. Only add a parallel `snip-runner:scan` bridge if
automated coverage is later wanted; do not build it upfront.

---

## 7. UI integration (on the `ui` branch)

### 7.1 `Picker.tsx` (modify)

The split button's chevron menu is the home for the new modes. Today `MODES` holds two
element modes; widen it to include the four page modes, and make the main button branch
on whether the active mode is an element pick or a page scan.

- Widen the mode type to `'snip' | 'assistive' | 'colors' | 'fonts' | 'assets' | 'schema'`.
- `MODES` entries gain a `kind: 'element' | 'page'` and the page modes get scan-flavored
  action labels (e.g. `Scan Colors`, `Scan Fonts`, `Scan Assets`, `Scan Style JSON`).
  The menu shows a thin divider between the element group and the page group (one new
  `.sc-menu-group`/`.sc-menu-divider` rule in `global-css.ts`).
- `onPick()` branches: element kind → `startPicker(mode)` (unchanged); page kind →
  `startScan(scan)`, a new sibling that sends `SNIPCODE_START_SCAN`. Page scans need no
  overlay and no screenshot, so there is no "Selecting… (Esc to cancel)" state; instead
  the main button shows a transient `Scanning…` while the scan runs.
- The mode is still owned by `App` and passed down, unchanged.

### 7.2 `App.tsx` (modify)

- Widen `Mode` to the six-value union; the picker already drives it.
- Add `inspect` result state and an `INSPECT_RESULT` listener beside the existing
  `SNIP_RESULT` one. A new scan clears the prior snip result and vice-versa, so the
  capture view shows exactly one current result.
- In the `capture` view body, render `ResultPanel` for snip/assistive results and
  `InspectPanel` for inspect results (whichever is current). The `ViewLayout` + footer
  (`Picker` + token counter) is unchanged.
- Colors/Style JSON token usage from the AI pass adds into the existing `sessionTokens`
  counter (the `INSPECT_RESULT` payload carries `usage` like `SNIP_RESULT` does).

### 7.3 New components

v1's panels are the reference for look and interaction (`App.tsx` lines ~1131–1286):
font cards show an "Aa" preview + family, click-to-copy; color cards show a swatch + hex
+ role, click-to-copy; asset cards show a thumbnail/inline-svg preview + filename + type,
click-to-download; the schema is a `<pre>` code block with copy. Recreate that in v2's
component style under a small subfolder. This is a **deliberate, approved decision**: it is
the first subfolder under `components/` (which is otherwise flat), chosen because grouping
the six cohesive inspect views reads more cleanly than mixing them into the flat shell
components, and it matches `content/`'s subfolder style. Do not flatten it back.

```
src/components/inspect/
  InspectPanel.tsx   routes an InspectResult.kind to the right view below
  InspectCard.tsx    shared card primitive: preview slot + name + meta + one action
  FontGrid.tsx       font cards (Aa preview in the family; copy family on click)
  ColorGrid.tsx      color cards (swatch; hex + AI role; copy hex on click)
  AssetGrid.tsx      asset cards (img / inline-svg thumb; filename + type + dims; download)
  SchemaView.tsx     Style JSON code block (copy / download), reusing the code surface
```

- `SchemaView` reuses the code surface through a **new shared `components/CodeBlock.tsx`**,
  extracted from `ResultPanel`. `ResultPanel` already renders a scrollable monospace `<pre>`
  with copy/download; pull that primitive (scroll surface + copy + download + copied
  feedback) into `CodeBlock` and have both `ResultPanel` and `SchemaView` render it. This is
  a clean boundary. If extracting `CodeBlock` turns fiddly (many props, special-casing), the
  clean fallback is a tiny self-contained code box inside `SchemaView` — not routing a
  synthetic `SnipResult` through `ResultPanel`, which is semantically wrong (Style JSON is
  not a snip) and couples schema rendering to snip-only concerns (the format eyebrow,
  multi-file tabs). Extract only if it stays simple; do not force the split.
- All four grids share `InspectCard` so spacing, hover, and the copied/downloaded
  feedback are defined once.

### 7.4 Styling (`global-css.ts` + `theme.ts`)

- New `sc-*` classes for the card grid and its hover/copy states
  (`.sc-inspect-grid`, `.sc-inspect-card`, `.sc-inspect-card:hover`, the font preview,
  the color swatch, the asset thumbnail, the menu divider). Interactive states belong in
  `global-css.ts` per the styling invariant; the grid layout and one-off spacing stay
  inline in the components.
- Any new shared value (swatch border, card surface, thumbnail background) goes in
  `theme.ts` (`COLORS` / `SURFACE` / `RADIUS`), imported by both sides. No new literals
  duplicated across files.

---

## 8. Storage and settings

- **No new persistent capture results.** Inspector output is transient (rendered in the
  panel), like a snip result. It is not added to the saved-snippets store.
- **AI behavior is automatic on key presence**, matching v1's "use AI when available." No
  settings toggle: a user with a key wants the AI, and no key already falls back to raw
  output, so an on/off switch solves a problem nobody has. Do not add `aiEnhanceInspectors`
  or any related preference/UI.
- v1's Style JSON had a `window.confirm` credit estimate before the server call. **Drop
  it** — BYOK has no credits, and a modal mid-scan is hostile. A token estimate can be
  shown passively next to the existing session token counter instead.

---

## 9. New and modified files (the manifest)

**New (`src/content/inspect/`):** `types.ts`, `fonts.ts`, `assets.ts`, `colors.ts`,
`ai.ts`, `prompts.ts`, `schema/extract.ts`, `schema/classify.ts`, `schema/fingerprint.ts`,
`schema/optimize.ts`, `schema/types.ts`.

**New (`src/components/inspect/`):** `InspectPanel.tsx`, `InspectCard.tsx`, `FontGrid.tsx`,
`ColorGrid.tsx`, `AssetGrid.tsx`, `SchemaView.tsx`.

**New (`src/components/`):** `CodeBlock.tsx` — *only if* the lift from `ResultPanel` stays
clean (shared scroll + copy/download surface for both `ResultPanel` and `SchemaView`).
Otherwise skip it and give `SchemaView` its own minimal code box (§7.3).

**Modified:**
- `src/components/Picker.tsx` — page modes + `startScan` branch.
- `src/components/ResultPanel.tsx` — render the extracted `CodeBlock` (only if the lift is
  clean; otherwise leave `ResultPanel` untouched and give `SchemaView` its own code box).
- `src/App.tsx` — `INSPECT_RESULT` listener + `InspectPanel` routing + widened `Mode`
  (audit every `Mode` reference: `App` type, `Picker` props/`MODES`/`onPick`, and any
  persisted last-mode; `ViewLayout` is unaffected).
- `src/content/index.ts` — `SNIPCODE_START_SCAN` handler, `runScan`, `INSPECT_RESULT` ship.
- `src/content/types.ts` — only if a shared type is needed panel-side, re-export inspect
  result types.
- `public/background.js` — generalize `llmRequest` to return `{ text, usage }`; optional
  per-request `max` tokens; remove `parseReply`.
- `src/content/polish/llm.ts` — own its reply parsing (moved from `background.js`),
  behavior unchanged.
- `src/global-css.ts` — inspect grid/card/menu-divider classes.
- `src/theme.ts` — any new shared tokens.
- `src/utils/log.ts` + a small shared url-absolutize helper (lifted from `assistive/assets.ts`).
- `Tasks/TASKS.md` — short note pointing at this plan.

---

## 10. Testing

- **Headless extractor tests.** Via the new `snip-runner:scan` bridge, run each inspector
  against a couple of local `file://` fixtures and assert the report shape and stability
  (run twice → byte-identical raw output, the determinism check already used for the
  pipeline). The AI pass is non-deterministic and stays out of the graded path, exactly
  as polish does in `runHeadless`.
- **Schema universality.** Run `extractSchema` against several saved fixtures from
  different sites; assert it never throws, respects its caps (style map ≤ 80, etc.), and
  produces no per-site-specific output. This guards the "universal, not example-specific"
  rule.
- **UI smoke.** With `/browse`, load the side panel, pick each page mode from the chevron
  menu, run a scan on a content-rich page, and confirm the grid/code render, copy works,
  and asset download works. Confirm "no key" shows raw colors/schema with no error.
- **No-regression.** Snip and Assistive paths are untouched logically; confirm a normal
  snip still emits and that the `polish/llm.ts` parser move is behavior-identical.

---

## 11. Suggested sequencing

Each milestone is independently shippable and reviewable.

1. **Base + scaffolding.** Re-base onto `ui` (§3, on go-ahead). Add `inspect/types.ts`,
   the `SNIPCODE_START_SCAN`/`INSPECT_RESULT` wiring in `content/index.ts`, the picker
   page modes, and an empty `InspectPanel`. Nothing renders yet but the round-trip works.
2. **Fonts + Assets (raw, no AI).** Port `inspect/fonts.ts` and `inspect/assets.ts`; build
   `FontGrid`, `AssetGrid`, `InspectCard`. These are the simplest and prove the UI shape.
3. **Colors + the AI plumbing.** Generalize the broker (§5), move polish's parser, add
   `inspect/colors.ts`, `inspect/ai.ts`, `inspect/prompts.ts` (colors prompt), `ColorGrid`.
   Colors works raw without a key and gains roles with one.
4. **Style JSON.** Port `inspect/schema/*` (the largest item; decompose as in §4), wire
   `enhanceSchema`, build `SchemaView`. Land raw-first, then the AI synthesis.
5. **Polish.** Token-counter integration, `global-css`/`theme` cleanup, docs, and the
   self-audit pass against the §14 cleanliness bar.

---

## 12. Open questions / risks

- **`ui` ↔ `improvements` reconciliation.** Out of scope here, but someone must
  eventually merge the UI redesign with the fidelity work. This plan is written so the
  inspector code does not collide with either (it only adds files and small wiring).
- **Resist schema scope creep.** v1's schema has ~15 blueprint detectors that already
  worked. Port them faithfully and make them readable; do not redesign, drop working
  behavior, swap in libraries, or change the output shape. The risk on this feature is
  over-engineering, not under-building (see the Guiding principle).
- **AI cost/latency on big pages.** Schema JSON can be tens of KB. Keep the local
  `optimize.ts` caps aggressive so the prompt stays small, and show the token estimate
  passively. The block-vs-non-block question is already resolved in §5: render raw
  immediately, fold the AI result in on a second ship, with a timeout that degrades to the
  raw output. Not an open question.
- **Provider output limits.** Raising `max` tokens for schema synthesis must stay within
  each provider's ceiling; clamp it in the broker (§5) and document the chosen value.

---

## 13. Review provenance

This plan was pressure-tested before any code, by two independent reviews (a cleanliness
audit against the actual codebase, and an adversarial architecture challenge with MV3 web
research) plus direct reading of the live `ui`-branch source and `background.js`.

**Confirmed as the best choice for this codebase (not changed):**
- Running page scans in the already-injected content script, rather than
  `chrome.scripting.executeScript`. The inspectors are too large to inline as a
  self-contained injected function, and `executeScript` does not rescue the real failure
  cases (`chrome://`, Web Store, PDF). Reuse + single execution world win here.
- One-shot `INSPECT_RESULT` messaging; independent inspector modules over a shared
  envelope; generalizing the LLM broker to raw text (a genuine separation-of-concerns win,
  not just plumbing).

**Folded in from the reviews (the deltas above):** the `{ text, usage }` broker shape and
optional per-request `max` (§5); URL-not-inlined asset payloads (§6); ui-local signal consts
+ the ensure-injected guard (§6); scope-explicit `extractPage*` names and the live-DOM file
header (§4); the extracted shared `CodeBlock` (§7.3, §9); and the `Mode`-cascade audit (§9).

**Deliberately rejected as over-engineering** (per the Guiding principle, after the product
owner confirmed these features already worked and should not be redesigned): swapping in a
CSS-analyzer dependency, changing the output to the W3C DTCG format, provider
structured-output/JSON mode, and a non-blocking/timeout AI state machine. These change
behavior or add complexity for no benefit the user asked for. The AI pass stays as simple
as `polish`.

---

## 14. The cleanliness bar (what "as clean as possible" means here)

Behavior is fixed; the only variable left is code quality, so this is the real
deliverable. Every file is held to these, and milestone 5 is a self-audit pass against
them:

1. **One concern per file, small files.** The 1,773-line schema monolith becomes five
   focused modules; nothing new exceeds a couple hundred lines. If a file is doing two
   jobs, split it.
2. **Reuse before adding.** Mirror what exists rather than duplicate it: `inspect/ai.ts`
   mirrors `polish/llm.ts`; the inspector modules mirror the `assistive/` sibling; the
   code surface is the shared `CodeBlock`; the card grids share `InspectCard`; colors come
   from `theme.ts`; hover states from `global-css.ts`. No copy-pasted blocks.
3. **Names that read.** Functions say what they do and at what scope
   (`extractPageColors`, not `extract`); types say what they hold (`FontReport`). A
   reviewer should not need the body to know the intent.
4. **Carry no dead weight.** Drop v1's `_archive/` code, the server/`idToken`/credit
   paths, commented-out branches, and any `FontInfo`/`AssetInfo` fields the UI never
   renders. A faithful port of *behavior* is not a port of *cruft*.
5. **Every file self-documents.** The standard header block (why it exists, what it reads,
   its place in the flow) plus sentence-case, self-contained comments. No plan labels, no
   em dashes in code.
6. **Readable over clever.** Straight-line code over abstraction; the AI pass is a single
   inline call, not a state machine. Prefer the boring version a newcomer can follow.
7. **Fail soft, never throw across a boundary.** Each inspector collects its own
   `warnings: string[]` and returns a partial result, matching `runFeatures`.
8. **Leave the tree navigable.** Files land where the existing structure says they should
   (`content/inspect/`, `components/inspect/`); no surprise locations, no new top-level
   patterns invented just for this work.

The litmus test for every file: *could someone who has never seen v1 read this module
top-to-bottom and understand both what it does and why, without cross-referencing?* If
not, it is not done.

---

## Sources

MV3: [chrome.scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting) ·
[service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle) ·
[execution-time limits](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/L3EbiNMjIGI) ·
[content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts) ·
[large message transfers](https://hackernoon.com/large-files-transfers-between-parts-of-chrome-extensions-for-manifest-v3).
