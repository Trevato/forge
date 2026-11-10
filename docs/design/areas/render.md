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

## SARIF findings (.sarif)

`src/web/render/sarif.ts` draws one existing `.table` (`data-dense`) per run under an `h3` with the tool's name, with the level counts as a plain line above. `.sarif-view` is only a hook on the wrapper and has no rule. How it works: `docs/features/file-sarif.md`.

## JUnit results (.junit.xml, TEST-*.xml)

`src/web/render/junit.ts` draws the totals as a plain line, opened by one sentence of what the file is, then per suite an `h3`, one existing `.table` (`data-dense`) of its failing cases with each body in a `pre` below, and the passing cases inside one native `details`. `.junit-view` is only a hook on the wrapper and has no rule. The XML reader is its own: no DOCTYPE, no entity but the five predefined, at most 2,000 cases drawn (failing first). How it works: `docs/features/file-junit.md`.

## OpenAPI operations (openapi.json, *.openapi.yaml)

`src/web/render/openapi.ts` draws one `h3` per tag and under it one existing `.table` (`data-dense`) of method, path, summary and a `deprecated` mark; the cap line is a `muted small` paragraph. `.openapi-view` is only a hook on the wrapper and has no rule. How it works: `docs/features/file-openapi.md`.
