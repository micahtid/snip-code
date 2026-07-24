# SnipCode

SnipCode is a Chrome extension that turns any element on any page into clean code.

Point at an element and it gives you the markup and the styles behind it. It reads the styles
the browser actually rendered, not just the ones written in the markup, so the result matches
what you saw on screen.

Everything runs in your browser. There is no account, no server, and no cloud sync.

## What It Does

- Snip one element into ready to use code.
- Press Shift to start selecting several elements, then press Enter to snip them all at once.
- Bookmark the snippets you want to keep. Saved snippets never age out of history.
- Scan a whole page for its fonts, assets, colors, or full design schema.

## Output Formats

One capture produces any of seven formats. Pick your default in Settings.

- `html` is a self contained document with an inline stylesheet.
- `tailwind` is html with Tailwind classes.
- `bem-css` is BEM classes plus a CSS file.
- `bem-scss` is BEM classes plus an SCSS file.
- `jsx-tailwind` is a React component with Tailwind classes.
- `jsx-css` is a React component with BEM plus CSS.
- `vue` is a Vue single file component.

## Installing

SnipCode is on the Chrome Web Store at
https://chromewebstore.google.com/detail/snipcode/njpicmnoclpenaomomflkmenlfpefcam

To load it unpacked instead, build it first:

```bash
npm install
npm run build
```

Then open `chrome://extensions`, turn on Developer mode, click Load unpacked, and select the
`dist/` folder. The toolbar icon opens the side panel. Chrome 122 or later is required.

## Using It

1. Click the toolbar icon to open the side panel.
2. Click Snip Element. The page dims and a highlight follows your cursor.
3. Hover the element you want. Press the up arrow to select its parent, or Esc to cancel.
4. Click to snip. The code appears in the panel and lands in your history.

To snip several elements at once, press Shift. That turns multi-select on and it stays on with
the key released, so clicking and scrolling both work normally. Every click now selects an
element, and clicking a selected one drops it. Each selection gets a numbered badge, and a
strip at the bottom of the page shows the count. Press Enter to snip them all, Esc to cancel,
or Shift again to leave the mode while nothing is selected. The panel shows one pill per
component, and Download saves them as a single zip with a folder each.

To scan the whole page instead of one element, open the mode menu beside the main button and
choose fonts, assets, colors, or schema.

## Bring Your Own Key

SnipCode works with no key at all. Adding one turns on an optional AI polish step that renames
generated classes to semantic ones and adds grouping comments. Your key is stored on your
machine in the browser's local storage. It never syncs to the cloud and never reaches a server
of ours.

Open Settings and choose a provider. OpenRouter, Anthropic, OpenAI, and Google are supported.
Paste your key, optionally override the model, and click Test Key to check it.

## Privacy

SnipCode makes two kinds of network request. It calls your own AI provider, with your own key,
for the optional polish step. It fetches stylesheets from other domains so it can read the
page's styles correctly. There is no telemetry, no analytics, and no account.

It asks for these permissions:

- Site access, to read the element you snip.
- `scripting`, to run the capture on the page.
- `storage` and `unlimitedStorage`, to keep settings, keys, and snippets locally.
- `downloads`, to save files to your device.
- `sidePanel`, to open the side panel.
- `debugger`, to read exact computed styles.

## How The Code Is Organized

The side panel is a React app under `src/`. `App.tsx` is the only React root and owns the three
views: capture, history, and settings. `src/components/` holds the panel UI, `src/theme.ts` and
`src/global-css.ts` hold every design token, and `src/utils/` holds storage, downloads, and
provider access.

The snip pipeline lives under `src/content/` and runs in the page, one directory per phase:

- `capture/` drives the element picker and reads the rendered element.
- `resolve/` resolves the styles that element actually renders with.
- `reconcile/` reconciles those styles against the page's own rules.
- `minimize/` drops everything the output does not need.
- `convert/` emits the chosen format and splits the result into files.
- `polish/` applies the optional AI pass for class names and comments.
- `inspect/` and `assistive/` handle the page scans and the assistive JSON emit.

`src/content/index.ts` is the orchestrator that runs those phases in order and ships the result
to the panel.

## Developing

```bash
npm install
npm run typecheck
npm run build
npm test
```

`npm test` runs the unit tests plus the picker, panel, and batch end to end suites. The
fidelity harness is separate: run `node tests/run-pipeline.mjs` to snip the frozen corpus, then
`node tests/split-render.mjs` to check the split file set renders the same as the self
contained document.

Contributions are welcome. Open an issue at https://github.com/micahtid/snip-code/issues to
report a bug or suggest a feature.

## License

[MIT](./LICENSE)
