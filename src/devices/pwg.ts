/**
 * PWG raster (PWG 5102.4) read just far enough to vouch for it: the `RaS2`
 * sync word, then per page a 1796-byte header and PackBits-coded lines. Every
 * page is walked, because the only way to find the next header is to decode
 * this page's lines; nothing is sent to a printer that this walk refuses.
 * Plain bytes in, plain data out.
 */

import { err, ok, type Result } from "../kernel/result.ts";

export const PWG_MAX_BYTES = 80 * 1024 * 1024;
export const PWG_MAX_PAGES = 20;
export const PWG_HEADER_BYTES = 1796;
/** Sides and line length no real page reaches; keeps a forged header from making a long walk. */
const MAX_SIDE = 40_000;

export interface PwgPage {
  readonly width: number;
  readonly height: number;
  /** Dots per inch, across and down. */
  readonly dpi: readonly [number, number];
  /** The IPP keyword for the pixel format, e.g. `sgray_8`. */
  readonly type: string;
}

export type PwgError = "not_raster" | "raster_truncated" | "too_many_pages" | "raster_unsupported";

/** cupsColorSpace values PWG raster allows, with their channel counts and keyword stems. */
const SPACES: Record<number, { channels: number; stem: string }> = {
  18: { channels: 1, stem: "sgray" },
  19: { channels: 3, stem: "srgb" },
  20: { channels: 3, stem: "adobe-rgb" },
};

/** The pages of a PWG raster document, or why it is refused. */
export function readPwg(bytes: Uint8Array): Result<PwgPage[], PwgError> {
  if (bytes.length < 4 || String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!) !== "RaS2") return err("not_raster");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pages: PwgPage[] = [];
  let at = 4;
  while (at < bytes.length) {
    if (pages.length === PWG_MAX_PAGES) return err("too_many_pages");
    if (at + PWG_HEADER_BYTES > bytes.length) return err("raster_truncated");
    const h = at;
    const dpi: [number, number] = [view.getUint32(h + 276), view.getUint32(h + 280)];
    const width = view.getUint32(h + 372);
    const height = view.getUint32(h + 376);
    const bitsPerColor = view.getUint32(h + 384);
    const bitsPerPixel = view.getUint32(h + 388);
    const bytesPerLine = view.getUint32(h + 392);
    const space = SPACES[view.getUint32(h + 400)];
    if (!space || (bitsPerColor !== 8 && bitsPerColor !== 16) || bitsPerPixel !== bitsPerColor * space.channels) return err("raster_unsupported");
    if (width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE || dpi[0] < 1 || dpi[1] < 1) return err("raster_unsupported");
    if (bytesPerLine !== Math.ceil((width * bitsPerPixel) / 8)) return err("raster_unsupported");
    at += PWG_HEADER_BYTES;
    const pixel = bitsPerPixel / 8;
    let rows = 0;
    while (rows < height) {
      if (at >= bytes.length) return err("raster_truncated");
      const repeat = bytes[at++]! + 1;
      let line = 0;
      while (line < bytesPerLine) {
        if (at >= bytes.length) return err("raster_truncated");
        const c = bytes[at++]!;
        if (c === 128) break; // the rest of the line is white
        const run = c < 128 ? c + 1 : 257 - c;
        line += run * pixel;
        at += c < 128 ? pixel : run * pixel;
        if (line > bytesPerLine) return err("raster_unsupported");
      }
      if (at > bytes.length) return err("raster_truncated");
      rows += repeat;
      if (rows > height) return err("raster_unsupported");
    }
    pages.push({ width, height, dpi, type: `${space.stem}_${bitsPerColor}` });
  }
  if (pages.length === 0) return err("raster_truncated");
  return ok(pages);
}

/**
 * Whether the printer's answers (`pwg-raster-document-resolution-supported`,
 * `pwg-raster-document-type-supported`) rule a page out; undefined when they
 * allow it or the printer does not say.
 */
export function unsupportedBy(
  page: PwgPage,
  resolutions: readonly [number, number][] | undefined,
  types: readonly string[] | undefined,
): "raster_resolution_refused" | "raster_type_refused" | undefined {
  if (resolutions && resolutions.length > 0 && !resolutions.some(([x, y]) => x === page.dpi[0] && y === page.dpi[1])) return "raster_resolution_refused";
  if (types && types.length > 0 && !types.includes(page.type)) return "raster_type_refused";
  return undefined;
}
