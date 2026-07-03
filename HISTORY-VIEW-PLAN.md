# History View Plan

Two small changes to the History view. No storage or schema changes — every
snippet's code is already persisted (`output.html` / `output.css` / `output.jsx`
on `SnippetRecord`). The FIFO cap stays at 50.

## Change 1: Card title shows the website link

**File:** `src/components/SnippetList.tsx` (~line 78)

Change the card title from the page title (falling back to url) to the url:

- Before: `{snip.page.title || snip.page.url}`
- After: `{snip.page.url}`

Keep the existing ellipsis/overflow styling. The format + date subtitle is
unchanged.

Open choice: render the url as plain text (current styling) or as a clickable
link that opens the page in a new tab. Default: plain text.

## Change 2: Per-card Save button

**File:** `src/components/SnippetList.tsx`

Add a small "Save" button to each card row that downloads that single snippet's
code. Reuses what already exists:

- `EXT` map (line 25) for the format -> file extension
- `triggerDownload` util (already imported)

Default: save the raw code file (`.html` / `.jsx` / `.vue`), named from the
page slug. Alternative: a mini-zip mirroring one Export All folder (code +
styles.css + screenshot + meta). ~15 lines either way.

## Out of scope

- Snippet cap: unchanged at 50 (`SNIPPET_CAP` in `src/utils/storage.ts`).
- No changes to capture, storage, or the `SnippetRecord` shape.
