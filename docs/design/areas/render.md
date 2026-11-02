# Render (PDF on the blob page)

A PDF is drawn by the browser's own viewer (`src/web/render/pdf.ts`, styled in `src/web/style/content.ts`).
No script, no pdf.js.

- `.pdf-view` — the existing `.card`, clipping the frame.
- `.pdf-frame` — the `<object type="application/pdf">`: 80vh (min 480px), 60vh (min 360px) at 600px and under, so the page does not shift when the viewer loads.
- `.pdf-fallback` — inside the object, shown only when the viewer cannot draw: an "Open the PDF" link and a `.btn` Download (`?download=1`).

The header shows the size (`1.2 MB · PDF`) through `Rendered.summary`. Both themes use tokens only.
