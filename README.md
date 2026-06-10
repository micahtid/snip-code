# SnipCode

snip any element on any page into clean, framework-formatted code, or a
structured json document a coding agent can act on. runs entirely in your
browser. no account, no backend, no cloud sync. bring your own llm key.

chrome extension, manifest v3, version 2.0.0.

## what it does

pick an element with the overlay picker, and snipcode reconstructs it as a
standalone, pixel-faithful artifact. it captures the rendered cascade (including
cross-origin and shadow-dom styles via the devtools protocol), bakes the styles
that would otherwise be lost when the element leaves the page, resolves variables
and fonts, and emits clean output.

two modes:

- **snip**, produces production code in one of 7 formats and fills the sidebar
  panels (code, colors, fonts, assets).
- **assistive**, produces a json document with the page url, a shortest-unique
  selector and a robust `data-*` selector, bounding box, fonts, and assets,
  delivered to your clipboard, a file, or a webhook.

builder pages (framer, wix, webflow, elementor, readymag) are intentionally
unsupported, they render runtime-dependent markup that cannot be snipped into
clean code, so snipcode refuses rather than emit broken output.

## install (development)

```
npm install
npm run build      # builds dist/ (sidebar + content script + manifest + icons)
```

then load the extension:

1. open `chrome://extensions`
2. enable **developer mode** (top right)
3. click **load unpacked** and select the `dist/` folder

the toolbar icon opens the side panel.

## first snip

1. open the side panel (click the snipcode toolbar icon)
2. choose **snip** mode
3. click **pick element**, the page dims and a highlight follows your cursor
4. hover the element you want; press **↑** to climb to a wrapping container, or
   **esc** to cancel
5. click to capture, the output appears in the sidebar and is saved to your
   recent snippets

## output formats

| format | description |
|---|---|
| `html` | inline-styled html + a `<style>` block for fonts/keyframes (self-contained) |
| `tailwind` | tailwind utility classes (palette-matched colors, arbitrary values for the rest) |
| `bem-css` | bem-named classes + a flat css stylesheet |
| `bem-scss` | bem-named classes + a nested scss stylesheet |
| `jsx-tailwind` | a react component with tailwind classes |
| `jsx-css` | a react component with bem classes + css |
| `vue` | a vue single-file component (`<template>` + `<style scoped>`) |

pick the default in settings; all 7 are produced from a single capture.

## byok (bring your own key)

snipcode never ships an api key and never proxies your requests. the optional
llm polish step (semantic class renames + hover/focus rules) uses your own key,
stored only in `chrome.storage.local` on your machine, never `chrome.storage.sync`,
never any server. phases 1-4 always run locally; phase 5 is skipped if no key is
configured.

to set up:

1. open the **settings** tab in the side panel
2. choose a provider:

   | provider | get a key | default model |
   |---|---|---|
   | OpenRouter | [openrouter.ai/keys](https://openrouter.ai/keys) | `google/gemini-3.0-flash` |
   | Anthropic | [console.anthropic.com](https://console.anthropic.com/) | `claude-haiku-4-5-20251001` |
   | OpenAI | [platform.openai.com](https://platform.openai.com/api-keys) | `gpt-5-mini` |
   | Google | [aistudio.google.com](https://aistudio.google.com/app/apikey) | `gemini-3.0-flash` |

3. paste your key (it is password-masked) and optionally override the model
4. click **test key** to validate it against the live provider

## assistive mode

switch the picker to **assistive** to get a json document instead of code. set
the delivery channels (clipboard / file / webhook) and, if using a webhook, its
url, in settings. the json schema is documented in `SNIPCODE-REWRITE-PLAN.md`
section 9.

## privacy

everything runs in your browser. the only network requests snipcode makes are:
your own llm provider (with your key, for the optional polish step), cross-origin
stylesheet fetches needed to capture styles, and your configured assistive
webhook. no telemetry, no analytics, no account.

## for contributors

the full build spec, architecture, the five principles, the feature-handler
discipline, and the test bench, lives in `SNIPCODE-REWRITE-PLAN.md`. the pipeline
is five phases (capture → reconcile → resolve → convert → polish), each under
`src/content/`. the grader (`tests/`) renders each bundle's output against a
ground-truth screenshot and scores it with pixelmatch + ssim.

## license

MIT, see [LICENSE](./LICENSE).
