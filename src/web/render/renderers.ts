/**
 * What draws each kind of file on the blob page. A renderer lives in its own
 * file beside this one (`render/<kind>.ts`) and is named once, in
 * `RENDERERS`; a kind missing here keeps the view it always had.
 */

import type { Html } from "../html.ts";
import type { FileKind } from "./kinds.ts";
import { markdown } from "./markdown.ts";

/** What a renderer is handed: the file, and where its bytes can be fetched. */
export interface RenderInput {
  readonly path: string;
  readonly size: number;
  /** The whole body, when the page read it; a heavy viewer fetches `media`. */
  readonly body: Uint8Array;
  /** `/:owner/:name/media/:ref/*path`, for `<img>`, `<video>` and `fetch()`. */
  readonly media: string;
}

export interface Rendered {
  readonly content: Html;
  /** Lines the file has, for the header's count; 0 when lines mean nothing. */
  readonly lines: number;
}

export type Renderer = (input: RenderInput) => Rendered;

export const RENDERERS: Partial<Readonly<Record<FileKind, Renderer>>> = {
  markdown,
};
