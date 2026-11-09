# Render (PDF on the blob page)

A PDF is drawn by the browser's own viewer (`src/web/render/pdf.ts`, styled in `src/web/style/content.ts`).
No script, no pdf.js.

- `.pdf-view` — the existing `.card`, clipping the frame.
- `.pdf-frame` — the `<object type="application/pdf">`: 80vh (min 480px), 60vh (min 360px) at 600px and under, so the page does not shift when the viewer loads.
- `.pdf-fallback` — inside the object, shown only when the viewer cannot draw: an "Open the PDF" link and a `.btn` Download (`?download=1`).

The header shows the size (`1.2 MB · PDF`) through `Rendered.summary`. Both themes use tokens only.

## Archive listing

A .zip, .tar or .tar.gz is drawn by `src/web/render/archive-view.ts` as the existing `.table` alone, with no `.card` around it (path, size, modified; `data-dense`), and a `tfoot` for the count and unpacked size. No new class: `.archive-view` is only a hook on the table and has no rule. How it works: `docs/features/archive-listing.md`. A list that cannot be read falls back to the Download card with the reason as its one sentence.
