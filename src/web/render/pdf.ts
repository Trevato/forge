/**
 * A PDF drawn by the browser's own viewer, from the media route. The
 * `<object>` holds the fallback, so with the viewer missing (iOS Safari
 * shows one page, or none) the file is still one tap away to open or
 * download; the frame has a fixed height, so nothing shifts when the viewer
 * arrives. The page that holds it sends `object-src 'self'` (`layout.ts`
 * `objectSrc`).
 */

import { html } from "../html.ts";
import { fileSize } from "../ui.ts";
import type { Rendered, RenderInput } from "./renderers.ts";

export function pdf(input: RenderInput): Rendered {
  return {
    lines: 0,
    summary: `${fileSize(input.size)} · PDF`,
    content: html`<div class="card pdf-view">
      <object class="pdf-frame" data="${input.media}" type="application/pdf">
        <p class="pdf-fallback">
          This browser cannot show the PDF here.
          <a href="${input.media}">Open the PDF</a>
          <a class="btn" href="${input.media}?download=1">Download</a>
        </p>
      </object>
    </div>`,
  };
}
