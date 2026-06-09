# SnipCode

snip any element on any page into clean, framework-formatted code — or a
structured json document a coding agent can act on. runs entirely in your
browser. no account, no backend, no cloud sync. bring your own llm key.

> **status:** v2.0.0 in active build. this is a fresh rewrite (chrome mv3,
> typescript, react sidebar) of the original SnipCode extension. the build spec
> lives in `SNIPCODE-REWRITE-PLAN.md`.

## what it does

- **snip mode** — pick an element, get production code in one of 7 formats:
  tailwind, css+bem, scss+bem, jsx+tailwind, jsx+css, vue sfc, or plain html+css.
- **assistive mode** — pick an element, get a json document with the page url,
  a shortest-unique selector and a robust `data-*` selector, bounding box,
  fonts, colors, and assets. delivered to clipboard, file, or webhook.

## install (development)

```
npm install
npm run build      # builds dist/ (sidebar + content script + manifest)
```

then load `dist/` as an unpacked extension at `chrome://extensions`
(developer mode → load unpacked).

## byok (bring your own key)

snipcode never ships an api key and never proxies your requests. the optional
llm polish step (cleaner class names, hover states) uses your own key, stored
only in `chrome.storage.local` on your machine. supported providers: openrouter,
anthropic, openai, google. configure one in the settings tab.

> full setup walkthrough, first-snip guide, and per-provider byok instructions
> land in the readme at commit 39. contributors: read `SNIPCODE-REWRITE-PLAN.md`.

## license

MIT — see [LICENSE](./LICENSE).
