/**
 * One door onto the decoders: sniff a format from its bytes, decode it to
 * RGBA, or say why not.
 *
 * Format is decided by content, never by extension. A repository is full of
 * files whose name lies — `logo.png` that is really a JPEG, `diagram.svg`
 * that is really a PDF — and a preview that trusts the name is a preview that
 * renders garbage into someone's terminal.
 *
 * The formats we cannot decode are named rather than lumped together, so the
 * surface can say "open on origin" for a WebP and "that is not an image" for
 * a tarball, which are very different sentences to a user.
 */

import { err, ok, type Result } from "../../kernel/result.ts";
import { decodeGif, gifHeader, isGif } from "./gif.ts";
import { decodeJpeg, isJpeg, jpegHeader } from "./jpeg.ts";
import { decodePng, isPng, pngHeader } from "./png.ts";

export type ImageFormat = "png" | "jpeg" | "gif" | "webp" | "svg" | "bmp";

export type DecodeError = "unsupported" | "corrupt" | "too_large";

export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  /** Row-major, 4 bytes per pixel, non-premultiplied. */
  readonly rgba: Uint8Array;
}

/**
 * The ceiling on what we will decode: 16 megapixels, which is a 4000×4000
 * photograph and 64 MB of RGBA. Past it we refuse rather than downscale,
 * because none of these formats can be decoded at a reduced size without
 * doing most of the work anyway (JPEG's DC-only 1/8 path is the exception,
 * and it is not worth a second entropy decoder). The message a user sees is
 * "too large to preview", which is true and actionable.
 */
export const MAX_PIXELS = 16 * 1000 * 1000;

/** What these bytes actually are, by magic number. */
export function sniff(bytes: Uint8Array): ImageFormat | undefined {
  if (isPng(bytes)) return "png";
  if (isJpeg(bytes)) return "jpeg";
  if (isGif(bytes)) return "gif";
  if (
    bytes.length >= 12 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 4) === "WEBP"
  )
    return "webp";
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return "bmp";
  if (isSvg(bytes)) return "svg";
  return undefined;
}

/**
 * SVG has no magic number, so this is a bounded sniff of the head: skip
 * whitespace and a BOM, allow an XML declaration, a doctype and comments,
 * and require an `<svg` element. Bounded because "is this XML" is not a
 * question worth scanning a 40 MB file to answer.
 */
function isSvg(bytes: Uint8Array): boolean {
  const head = ascii(bytes, 0, Math.min(bytes.length, 1024)).trimStart();
  const text = head.startsWith("﻿") ? head.slice(1) : head;
  if (/^<svg[\s>]/i.test(text)) return true;
  if (!/^<\?xml[\s?]/i.test(text) && !/^<!doctype\s+svg/i.test(text))
    return false;
  return /<svg[\s>]/i.test(text);
}

function ascii(bytes: Uint8Array, from: number, length: number): string {
  let out = "";
  const end = Math.min(bytes.length, from + length);
  for (let i = from; i < end; i++) out += String.fromCharCode(bytes[i]!);
  return out;
}

export interface ImageMeta {
  readonly format: ImageFormat;
  readonly width: number;
  readonly height: number;
}

/**
 * Geometry without decoding — what a file listing or a placeholder card
 * needs. Undefined for a format whose header we do not read (SVG's viewBox
 * is a parse, not a header) or for bytes that are not an image at all.
 */
export function measure(bytes: Uint8Array): ImageMeta | undefined {
  const format = sniff(bytes);
  if (format === "png") {
    const h = pngHeader(bytes);
    return h.ok
      ? { format, width: h.value.width, height: h.value.height }
      : undefined;
  }
  if (format === "jpeg") {
    const h = jpegHeader(bytes);
    if (!h.ok) return undefined;
    // Orientations 5–8 transpose, so the *displayed* geometry is swapped.
    const swap = h.value.orientation >= 5;
    return {
      format,
      width: swap ? h.value.height : h.value.width,
      height: swap ? h.value.width : h.value.height,
    };
  }
  if (format === "gif") {
    const h = gifHeader(bytes);
    return h.ok
      ? { format, width: h.value.width, height: h.value.height }
      : undefined;
  }
  return undefined;
}

export function decode(bytes: Uint8Array): Result<RgbaImage, DecodeError> {
  const format = sniff(bytes);
  if (format === undefined) return err("unsupported");
  if (format === "webp" || format === "svg" || format === "bmp")
    return err("unsupported");

  // Refuse on the header, before allocating anything: a 30000×30000 PNG is a
  // 30-byte header and a 3.6 GB decode, and that asymmetry is a denial of
  // service if the check comes after.
  const meta = measure(bytes);
  if (meta === undefined) return err("corrupt");
  if (meta.width * meta.height > MAX_PIXELS) return err("too_large");

  const decoded =
    format === "png"
      ? decodePng(bytes)
      : format === "jpeg"
        ? decodeJpeg(bytes)
        : decodeGif(bytes);
  if (!decoded.ok) return err(decoded.error);
  return ok(decoded.value);
}

/** Why a format was refused, in words a screen can print unchanged. */
export function unsupportedReason(format: ImageFormat | undefined): string {
  switch (format) {
    case "webp":
      return "WebP previews aren't decoded here yet — open it on the origin.";
    case "bmp":
      return "BMP previews aren't decoded here yet — open it on the origin.";
    case "svg":
      return "SVG is a document, not a bitmap — open it on the origin to render it.";
    default:
      return "That file isn't an image this terminal can decode.";
  }
}

/**
 * Box-filter downscale to fit inside `maxW`×`maxH`, preserving aspect.
 *
 * A box filter (average every source pixel that lands in a destination pixel)
 * rather than nearest-neighbour, because a screenshot reduced by
 * nearest-neighbour turns text into noise — the one case where the cheap
 * choice is visibly the wrong one. Upscaling is refused: the image comes back
 * unchanged rather than blurred.
 */
export function thumbnail(
  rgba: Uint8Array,
  w: number,
  h: number,
  maxW: number,
  maxH: number,
): RgbaImage {
  if (w <= 0 || h <= 0 || maxW <= 0 || maxH <= 0)
    return { width: w, height: h, rgba };
  const scale = Math.min(maxW / w, maxH / h);
  if (scale >= 1) return { width: w, height: h, rgba };
  const dw = Math.max(1, Math.floor(w * scale));
  const dh = Math.max(1, Math.floor(h * scale));
  const out = new Uint8Array(dw * dh * 4);

  for (let y = 0; y < dh; y++) {
    const sy0 = Math.floor((y * h) / dh);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * h) / dh));
    for (let x = 0; x < dw; x++) {
      const sx0 = Math.floor((x * w) / dw);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * w) / dw));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1 && sy < h; sy++) {
        for (let sx = sx0; sx < sx1 && sx < w; sx++) {
          const i = (sy * w + sx) * 4;
          // Weight colour by alpha so a transparent border does not drag the
          // edge pixels toward black.
          const av = rgba[i + 3]!;
          r += rgba[i]! * av;
          g += rgba[i + 1]! * av;
          b += rgba[i + 2]! * av;
          a += av;
          n++;
        }
      }
      const o = (y * dw + x) * 4;
      if (a === 0) {
        out[o + 3] = 0;
        continue;
      }
      out[o] = Math.round(r / a);
      out[o + 1] = Math.round(g / a);
      out[o + 2] = Math.round(b / a);
      out[o + 3] = Math.round(a / Math.max(1, n));
    }
  }
  return { width: dw, height: dh, rgba: out };
}

/**
 * Flatten transparency onto one background colour. Terminals composite an
 * image over their own background, but the *cell* background we reserve is a
 * theme colour, so an RGBA image with a transparent ground would show two
 * different blacks. Flattening first makes the seam disappear.
 */
export function flatten(rgba: Uint8Array, background: number): Uint8Array {
  const br = (background >> 16) & 0xff;
  const bg = (background >> 8) & 0xff;
  const bb = background & 0xff;
  const out = new Uint8Array(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3]! / 255;
    out[i] = Math.round(rgba[i]! * a + br * (1 - a));
    out[i + 1] = Math.round(rgba[i + 1]! * a + bg * (1 - a));
    out[i + 2] = Math.round(rgba[i + 2]! * a + bb * (1 - a));
    out[i + 3] = 255;
  }
  return out;
}

/** RGBA → packed RGB, for the encoders that take three bytes per pixel. */
export function toRgb(rgba: Uint8Array): Uint8Array {
  const out = new Uint8Array((rgba.length / 4) * 3);
  for (let i = 0, o = 0; i < rgba.length; i += 4, o += 3) {
    out[o] = rgba[i]!;
    out[o + 1] = rgba[i + 1]!;
    out[o + 2] = rgba[i + 2]!;
  }
  return out;
}
