/**
 * What draws each kind of file on the blob page. A renderer lives in its own
 * file beside this one (`render/<kind>.ts`) and is named once, in
 * `RENDERERS`; a kind missing here keeps the view it always had.
 */

import type { Html } from "../html.ts";
import type { Blob } from "../../view/source.ts";
import { audio } from "./audio.ts";
import { claimedMedia, fileKind, HEAD_BYTES, NO_BYTES, RENDER_CAP, type FileKind } from "./kinds.ts";
import { markdown } from "./markdown.ts";
import { video } from "./video.ts";

/** What a renderer is handed: the file, and where its bytes can be fetched. */
export interface RenderInput {
  readonly path: string;
  readonly size: number;
  /**
   * The whole body, when the page read it; empty for a file over the page's
   * read ceiling, which only a `STREAMED` kind is drawn from.
   */
  readonly body: Uint8Array;
  /** `/:owner/:name/media/:ref/*path`, for `<img>`, `<video>` and `fetch()`. */
  readonly media: string;
}

export interface Rendered {
  readonly content: Html;
  /** Lines the file has, for the header's count; 0 when lines mean nothing. */
  readonly lines: number;
  /** The header's facts in place of the line count, as `1.2 MB · WebM`. */
  readonly summary?: string;
}

export type Renderer = (input: RenderInput) => Rendered;

export const RENDERERS: Partial<Readonly<Record<FileKind, Renderer>>> = {
  markdown,
  audio,
  video,
};

/**
 * Kinds drawn wholly from the media route, never from the body: a file of
 * one of these too large for the page to read is still drawn, by its name,
 * and the media route confirms its bytes before it serves them as media.
 */
const STREAMED: ReadonlySet<FileKind> = new Set<FileKind>(["audio", "video"]);

/** The renderer for a file and the bytes it is handed, or none: the source view. */
export function rendererFor(
  path: string,
  blob: Blob,
): { render: Renderer; body: Uint8Array } | undefined {
  const kind =
    blob.kind === "too_large"
      ? claimedMedia(path)?.kind
      : fileKind(path, blob.body.subarray(0, HEAD_BYTES));
  if (kind === undefined || blob.size > RENDER_CAP[kind]) return undefined;
  if (blob.kind === "too_large" && !STREAMED.has(kind)) return undefined;
  const render = RENDERERS[kind];
  if (render === undefined) return undefined;
  return { render, body: blob.kind === "too_large" ? NO_BYTES : blob.body };
}
