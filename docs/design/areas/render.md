# Render (PDF on the blob page)

A PDF is drawn by the browser's own viewer (`src/web/render/pdf.ts`, styled in `src/web/style/content.ts`).
No script, no pdf.js.

- `.pdf-view` — the existing `.card`, clipping the frame.
- `.pdf-frame` — the `<object type="application/pdf">`: 80vh (min 480px), 60vh (min 360px) at 600px and under, so the page does not shift when the viewer loads.
- `.pdf-fallback` — inside the object, shown only when the viewer cannot draw: an "Open the PDF" link and a `.btn` Download (`?download=1`).

The header shows the size (`1.2 MB · PDF`) through `Rendered.summary`. Both themes use tokens only.

## Terminal log (.log, .ansi)

`src/web/render/log.ts` draws a log that holds escape codes inside the existing `.card.code` table, so it looks like any code file. Colour comes only from fixed classes (`src/web/style/content.ts`), tokens only, both themes:

- `.ansi-red` `--danger`, `.ansi-green` `--success`, `.ansi-yellow` `--attn`, `.ansi-blue` `--tok-number`, `.ansi-magenta` `--merged`, `.ansi-cyan` `--tok-property`, `.ansi-gray` (black) `--tok-comment`. White is the page's own ink.
- `.ansi-b` bold, `.ansi-u` underline.

Backgrounds, 256-colour above 15 and truecolour are dropped; so are cursor moves and OSC. A log with no escape code keeps the plain source view.

## Notebook (.ipynb)

`src/web/render/notebook.ts` draws cells as rows inside `.nb.prose`, with space between them and no box. Classes: `.nb-cell` (one row), `.nb-img` (an output picture, `max-width: 100%; height: auto` so a wide plot fits a phone), `.nb-cap` (a plain caption, muted, before HTML or script output shown as text). A long `pre` scrolls inside its cell, never the page.

## Archive listing

A .zip, .tar or .tar.gz is drawn by `src/web/render/archive-view.ts` as the existing `.table` alone, with no `.card` around it (path, size, modified; `data-dense`), and a `tfoot` for the count and unpacked size. No new class: `.archive-view` is only a hook on the table and has no rule. How it works: `docs/features/archive-listing.md`. A list that cannot be read falls back to the Download card with the reason as its one sentence.

## GPS track (.gpx)

`src/web/render/gpx.ts` draws the route as one inline SVG in `.gpx-view`: no fixed width or height, `max-width: 100%` and `height: auto` (tokens only, `currentColor` stroke, no accent), so it fits a 360px phone. Its facts (track, distance, climb, points) are the existing `.status-rows` / `.status-row`, with no box. How it works: `docs/features/gpx.md`.

`src/web/render/geojson.ts` draws a GeoJSON file as one inline SVG in `.gj-view` (same rules as `.gpx-view`: no fixed size, `max-width: 100%`, `currentColor`), and the first 100 features' properties as a plain table in `.gj-table`, which scrolls sideways inside its own box on a phone.

## Request waterfall (.har)

`src/web/render/har.ts` draws a HAR as the existing `.table` (`data-dense`) inside `.har-view`, which scrolls sideways on a phone. Each row's timing bar is one inline SVG, `.har-url` (the URL cell, wraps anywhere) and `.har-bar` (the full width of the URL cell, under the URL, 10px tall, `--muted-fg` (it is data, not a control, so not the accent), `aria-hidden` since the Time column says the same in words, no inline style). `.har-url` has `min-width: 200px` so a row never squeezes to a sliver; that cannot make the page scroll, because `.har-view` is `overflow-x: auto`, so any excess width scrolls inside the table's own box, not the page. Headers sit in a native `<details>` under the URL. How it works: `docs/features/file-har.md`.

## SARIF findings (.sarif)

`src/web/render/sarif.ts` draws one existing `.table` (`data-dense`) per run under an `h3` with the tool's name, with the level counts as a plain line above. `.sarif-view` is only a hook on the wrapper and has no rule. How it works: `docs/features/file-sarif.md`.

## JUnit results (.junit.xml, TEST-*.xml)

`src/web/render/junit.ts` draws the totals as a plain line, opened by one sentence of what the file is, then per suite an `h3`, one existing `.table` (`data-dense`) of its failing cases with each body in a `pre` below, and the passing cases inside one native `details`. `.junit-view` is only a hook on the wrapper and has no rule. The XML reader is its own: no DOCTYPE, no entity but the five predefined, at most 2,000 cases drawn (failing first). How it works: `docs/features/file-junit.md`.

## Environment example (.env.example)

`src/web/render/env.ts` draws one existing `.table` (`data-dense`): name, example, comment, with group headings as full-width `th` rows. `.env-view` is only a hook on the wrapper and has no rule. How it works: `docs/features/file-env.md`.

## Package manifest (package.json)

`src/web/render/package-json.ts` draws an `h2`, a `muted small` facts line, then per section an `h3` and one existing `.table` (`data-dense`) in a `.table-scroll`; commands and ranges are `code.break`. `.package-view` is only a hook and has no rule. How it works: `docs/features/file-package-json.md`.

## OpenAPI operations (openapi.json, *.openapi.yaml)

`src/web/render/openapi.ts` draws one `h3` per tag and under it one existing `.table` (`data-dense`) of method, path, summary and a `deprecated` mark; the cap line is a `muted small` paragraph. `.openapi-view` is only a hook on the wrapper and has no rule. How it works: `docs/features/file-openapi.md`.

## Dockerfile stages (Dockerfile, Containerfile, *.Dockerfile)

`src/web/render/dockerfile.ts` draws one `section` per stage: an `h3` with the image, `small` paragraphs for exposed ports and ENV names, then one existing `.table` (`data-dense`) of keyword and arguments. `.dockerfile-view` is only a hook on the wrapper and has no rule. How it works: `docs/features/file-dockerfile.md`.

## GitHub Actions workflow (.github/workflows/*.yml)

`src/web/render/workflow.ts` draws a lead line with the triggers, then one `section` per job: an `h3` with the job, one existing `dl.status-rows` of its runner, needs and matrix, and one existing `.table` (`data-dense`) of its steps. `.workflow-view` is only a hook on the wrapper and has no rule. How it works: `docs/features/file-workflow.md`.

## SQL schema (*.sql)

`src/web/render/sql.ts` draws, per statement, either an `h3` with the table name and one existing `.table` (`data-dense`) of its columns, or a one-row `.table` with the statement's first line. `.sql-view` is only a hook on the wrapper and has no rule. How it works: `docs/features/file-sql.md`.
