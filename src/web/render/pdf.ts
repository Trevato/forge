/**
 * A PDF drawn by the browser's own viewer, from the media route. The
 * `<object>` holds a link, so with the viewer missing or JavaScript off the
 * file is still one tap away; the frame has a fixed height, so nothing shifts
 * when the viewer arrives. The page that holds it sends `object-src 'self'`
 * (`layout.ts` `objectSrc`).
 */

import { html } from "../html.ts";
import type { Rendered, RenderInput } from "./renderers.ts";

export function pdf(input: RenderInput): Rendered {
  return {
    lines: 0,
    content: html`<div class="card pdf-view">
      <p class="pdf-links">
        <a href="${input.media}">Open</a> ·
        <a href="${input.media}?download=1">Download</a>
      </p>
      <object class="pdf-frame" data="${input.media}" type="application/pdf">
        <p class="pdf-fallback">
          This browser cannot show the PDF here.
          <a href="${input.media}">Open it</a> or
          <a href="${input.media}?download=1">download it</a>.
        </p>
      </object>
    </div>`,
  };
}
