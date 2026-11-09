/**
 * What draws each kind of file on the blob page. A renderer lives in its own
 * file beside this one (`render/<kind>.ts`) and is named once, in
 * `RENDERERS`; a kind missing here keeps the view it always had.
 */

import type { Html } from "../html.ts";
import type { Blob } from "../../view/source.ts";
import { archive } from "./archive-view.ts";
import { audio } from "./audio.ts";
import { config } from "./config.ts";
import { isFormConfig } from "./config-format.ts";
import { csv } from "./csv.ts";
import { image } from "./image.ts";
import { claimedMedia, fileKind, HEAD_BYTES, NO_BYTES, RENDER_CAP, type FileKind } from "./kinds.ts";
import { markdown } from "./markdown.ts";
import { pdf } from "./pdf.ts";
import { subtitles } from "./subtitles.ts";
import { video } from "./video.ts";

/** What a renderer is handed: the file, and where its bytes can be fetched. */
export interface RenderInput {
  readonly path: string;
  readonly size: number;
  /**
   * The whole body, when the page read it; empty for a file over the page's
   * read ceiling, which only a media kind (`MEDIA_KINDS`) is drawn from.
   */
  readonly body: Uint8Array;
  /** `/:owner/:name/media/:ref/*path`, for `<img>`, `<video>` and `fetch()`. */
  readonly media: string;
  /** The file page's own address, for a link back to it (`?all=1`). */
  readonly pathHref?: string;
  /** `?all=1`: draw past the default window, up to the renderer's cap. */
  readonly all?: boolean;
}

export interface Rendered {
  readonly content: Html;
  /** Lines the file has, for the header's count; 0 when lines mean nothing. */
  readonly lines: number;
  /** The header's facts in place of the line count, as `1.2 MB · WebM`. */
  readonly summary?: string;
  /** Set when the file cannot be drawn: the source view shows, with this reason. */
  readonly fallback?: string;
}

export type Renderer = (input: RenderInput) => Rendered;

export const RENDERERS: Partial<Readonly<Record<FileKind, Renderer>>> = {
  image,
  svg: image,
  markdown,
  pdf,
  csv,
  audio,
  video,
  config,
  subtitles,
  archive,
};

/**
 * Kinds drawn wholly from the media route, never from the body: a file of
 * one of these too large for the page to read is still drawn up to its
 * `RENDER_CAP`, decided by its first bytes (or by its name, when the source
 * gave none), and the media route confirms its bytes before it serves them.
 * Every other kind is bounded by the page's own read ceiling.
 */
const MEDIA_KINDS: ReadonlySet<FileKind> = new Set<FileKind>([
  "image",
  "svg",
  "pdf",
  "audio",
  "video",
  "model3d",
]);

/** The renderer for a file and the bytes it is handed, or none: the source view. */
export function rendererFor(
  path: string,
  blob: Blob,
  renderers: Partial<Readonly<Record<FileKind, Renderer>>> = RENDERERS,
): { render: Renderer; body: Uint8Array } | undefined {
  const kind =
    blob.kind !== "too_large"
      ? fileKind(path, blob.body.subarray(0, HEAD_BYTES))
      : blob.head !== undefined
        ? fileKind(path, blob.head)
        : claimedMedia(path)?.kind;
  if (kind === undefined || blob.size > RENDER_CAP[kind]) return undefined;
  if (blob.kind === "too_large" && !MEDIA_KINDS.has(kind)) return undefined;
  // A kind may draw only some of its files: `config` draws JSON, YAML and
  // TOML as a form, and leaves the rest (INI, .env …) their source.
  const render = kind === "config" && !isFormConfig(path) ? undefined : renderers[kind];
  if (render === undefined) return undefined;
  return { render, body: blob.kind === "too_large" ? NO_BYTES : blob.body };
}
