/**
 * A look, made small enough to sit on a card: the picture is decoded,
 * reduced to fit `SHOT_MAX`, re-encoded and returned as a data URI, so the
 * card stays one self-contained SVG. A file that is missing, unreadable or
 * not a PNG is no picture (undefined), never an error: the card is then the
 * card it would have been without one.
 */

import { readFileSync } from "node:fs";
import { thumbnail } from "../../design/image/image.ts";
import { decodePng, encodePng } from "../../design/image/png.ts";

/** What a picture is reduced to fit, in pixels: twice the box it is drawn in. */
export const SHOT_MAX = { width: 480, height: 300 } as const;
/** A file past this is not read at all. */
const MAX_FILE = 4 * 1024 * 1024;

export function shotUri(path: string): string | undefined {
  try {
    const bytes = new Uint8Array(readFileSync(path));
    if (bytes.length > MAX_FILE) return undefined;
    const decoded = decodePng(bytes);
    if (!decoded.ok) return undefined;
    const { width, height, rgba } = decoded.value;
    const small = thumbnail(rgba, width, height, SHOT_MAX.width, SHOT_MAX.height);
    const png = encodePng(small.width, small.height, small.rgba);
    return `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
  } catch {
    return undefined;
  }
}
