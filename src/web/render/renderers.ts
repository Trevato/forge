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
import { envView } from "./env.ts";
import { sqlView } from "./sql.ts";
import { eml } from "./eml.ts";
import { csv } from "./csv.ts";
import { geojson } from "./geojson.ts";
import { gcode } from "./gcode.ts";
import { gpx } from "./gpx.ts";
import { font } from "./font.ts";
import { ics } from "./ics.ts";
import { junit } from "./junit.ts";
import { vcf } from "./vcf.ts";
import { htmlPreview } from "./html_preview.ts";
import { image } from "./image.ts";
import { fileKind, HEAD_BYTES, kindByName, NO_BYTES, RENDER_CAP, type FileKind } from "./kinds.ts";
import { log, hasEscape } from "./log.ts";
import { makefile } from "./makefile.ts";
import { markdown } from "./markdown.ts";
import { model3d } from "./model3d.ts";
import { notebook } from "./notebook.ts";
import { patch } from "./patch.ts";
import { pdf } from "./pdf.ts";
import { dockerfile } from "./dockerfile.ts";
import { openapi } from "./openapi.ts";
import { lcov } from "./lcov.ts";
import { sarif } from "./sarif.ts";
import { sqlite } from "./sqlite.ts";
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
  /** The same, saved under the file's own name (`downloadHref`). */
  readonly download: string;
  /** The file page's own address, for a link back to it (`?all=1`). */
  readonly pathHref?: string;
  /** The repository base and ref (as written in a URL), so a relative address resolves. */
  readonly repo?: { readonly base: string; readonly ref: string };
  /** Whether a repository-relative path is a file at the ref; a renderer that links paths links only these. */
  readonly exists?: (path: string) => boolean;
  /** `?all=1`: draw past the default window, up to the renderer's cap. */
  readonly all?: boolean;
  /** `?table=<name>`: unchecked text; a renderer matches it against its own list. */
  readonly table?: string;
  /** `?layer=N` (1-based) on a G-code file; the renderer clamps it to the layers it has. */
  readonly layer?: number;
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
  notebook,
  pdf,
  html: htmlPreview,
  csv,
  sqlite,
  audio,
  video,
  model3d,
  config,
  patch,
  log,
  subtitles,
  gpx,
  gcode,
  geojson,
  calendar: ics,
  contacts: vcf,
  sarif,
  lcov,
  junit,
  env: envView,
  sql: sqlView,
  openapi,
  makefile,
  dockerfile,
  mail: eml,
  archive,
  font,
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
  "html",
  "audio",
  "video",
  "model3d",
]);

/**
 * The renderer for a file and the bytes it is handed, or none: the source
 * view. `media` says whether the page has a media route: a live browse of
 * another forge (`/origins/…`) has none, so a media kind (`MEDIA_KINDS`)
 * keeps its source or binary view there.
 */
export function rendererFor(
  path: string,
  blob: Blob,
  renderers: Partial<Readonly<Record<FileKind, Renderer>>> = RENDERERS,
  where: { readonly media: boolean } = { media: true },
): { render: Renderer; body: Uint8Array } | undefined {
  // A file the source gave no bytes of is taken at its name: STL, OBJ and
  // glTF have no signature to read anyway.
  const kind =
    blob.kind !== "too_large"
      ? fileKind(path, blob.body.subarray(0, HEAD_BYTES))
      : blob.head !== undefined
        ? fileKind(path, blob.head)
        : kindByName(path);
  if (blob.size > RENDER_CAP[kind]) return undefined;
  if (MEDIA_KINDS.has(kind) && !where.media) return undefined;
  if (blob.kind === "too_large" && !MEDIA_KINDS.has(kind)) return undefined;
  // A kind may draw only some of its files: `config` draws JSON, YAML and
  // TOML as a form, and leaves the rest (INI, .env …) their source.
  // A log with no escape in it keeps the source view, exactly as plain text.
  const render =
    (kind === "config" && !isFormConfig(path)) || (kind === "log" && blob.kind !== "too_large" && !hasEscape(blob.body))
      ? undefined
      : renderers[kind];
  if (render === undefined) return undefined;
  return { render, body: blob.kind === "too_large" ? NO_BYTES : blob.body };
}
