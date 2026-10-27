/**
 * The browser's own player for an audio or video file, pointed at the media
 * route. Seeking is HTTP Range on that route; the bytes never pass through
 * the page, so a long video costs the blob page nothing to draw.
 *
 * A format the browser cannot decode is decided by the browser, not by us:
 * the element fails, and `MEDIA_PLAY_JS` swaps in the "can't play" note that
 * is already in the markup, hidden, with a Download beside it. With scripts
 * off, a `<noscript>` line offers the same Download under the player.
 */

import { html } from "../html.ts";
import { btn, empty, fileSize } from "../ui.ts";
import { claimedMedia } from "./kinds.ts";
import type { Rendered, RenderInput } from "./renderers.ts";

/**
 * The `<source>` types offered, in order. A QuickTime file is nearly always
 * H.264 in an MP4-shaped box, which browsers that answer "no" to
 * `video/quicktime` play as `video/mp4`; offering both lets each try.
 */
function sourceTypes(path: string): string[] {
  const type = claimedMedia(path)?.type ?? "application/octet-stream";
  return type === "video/quicktime" ? [type, "video/mp4"] : [type];
}

export function player(kind: "audio" | "video", input: RenderInput): Rendered {
  const sources = sourceTypes(input.path).map(
    (type) => html`<source src="${input.media}" type="${type}" />`,
  );
  const element =
    kind === "video"
      ? html`<video class="media-player" controls playsinline preload="metadata">${sources}</video>`
      : html`<audio class="media-player" controls preload="metadata">${sources}</audio>`;
  const container = claimedMedia(input.path)?.name ?? "Unknown format";
  const download = btn("Download", {
    href: `${input.media}?download=1`,
    variant: "primary",
    icon: "download",
  });
  return {
    lines: 0,
    summary: `${fileSize(input.size)} · ${container}`,
    content: html`<div class="media-pane" data-kind="${kind}">
      ${element}
      <div class="media-unplayable" hidden>
        ${empty({
          icon: "file",
          title: "Your browser can't play this format",
          note: `${container}, ${fileSize(input.size)}. Download it to play it elsewhere.`,
          action: download,
        })}
      </div>
      <noscript>
        <p class="muted small">If it does not play here, download it. ${download}</p>
      </noscript>
    </div>`,
  };
}

/**
 * Part of the shell script. `error` does not bubble, so it is caught on the
 * way down; a failing `<source>` matters only when it is the last one (the
 * browser tries the next itself), a failing element always does. A player
 * that failed before this script ran is found by its `networkState`.
 */
export const MEDIA_PLAY_JS = /* js */ `
  function unplayable(el) {
    var pane = el && el.closest ? el.closest('.media-pane') : null;
    var note = pane ? pane.querySelector('.media-unplayable') : null;
    if (!note) return;
    el.hidden = true;
    note.hidden = false;
  }
  doc.addEventListener('error', function (e) {
    var t = e.target;
    if (!t || !t.tagName) return;
    if (t.tagName === 'SOURCE' && !t.nextElementSibling) unplayable(t.parentElement);
    else if (t.classList && t.classList.contains('media-player')) unplayable(t);
  }, true);
  doc.querySelectorAll('.media-player').forEach(function (m) {
    if (m.error || m.networkState === 3) unplayable(m);
  });
`;
