/**
 * An HTML file drawn as the page it is, in a sandboxed frame. The frame's
 * `src` is the media route, which serves the bytes as `text/html` only under
 * a `sandbox` policy (`pages/media.ts` `htmlPolicy`), so the file's own
 * script never runs, on the forge's origin or in the frame. The `sandbox`
 * attribute carries no `allow-*` token either: two locks, not one. Relative
 * images and stylesheets resolve against the media address, beside the file;
 * the route's policy lets only files under the same ref load (`htmlPolicy`).
 * The file's bytes never enter this page's markup. The page that holds the
 * frame sends `frame-src 'self'` (`layout.ts` `frameSelf`).
 */

import { html } from "../html.ts";
import { fileSize } from "../ui.ts";
import type { Rendered, RenderInput } from "./renderers.ts";

export function htmlPreview(input: RenderInput): Rendered {
  return {
    lines: 0,
    summary: `${fileSize(input.size)} · HTML`,
    content: html`<iframe class="html-frame" sandbox="" src="${input.media}" title="Preview of ${input.path}" referrerpolicy="no-referrer" loading="lazy"></iframe>`,
  };
}
