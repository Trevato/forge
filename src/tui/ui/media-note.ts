/**
 * What the terminal says for an audio or video file it cannot play: that it
 * is not played here, and where a browser plays it — the media route, on the
 * forge's own address when one is configured. `undefined` for any other file.
 */

import { claimedMedia } from "../../web/render/kinds.ts";

export function mediaNote(
  path: string,
  size: string,
  /** `https://forge…/owner/name`, or undefined for a mirror the forge does not serve. */
  web: string | undefined,
  ref: string,
): string | undefined {
  const media = claimedMedia(path);
  if (media === undefined || (media.kind !== "audio" && media.kind !== "video")) return undefined;
  const what = `${media.kind === "audio" ? "Audio" : "Video"}, ${media.name}, ${size} — not played in the terminal.`;
  return web === undefined
    ? what
    : `${what} Play it in a browser: ${web}/media/${encodeURIComponent(ref)}/${path.split("/").map(encodeURIComponent).join("/")}`;
}
