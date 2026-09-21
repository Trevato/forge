/**
 * The mark — the gradient square in the wordmark and the favicon — as a
 * raster, for the places that cannot take an SVG: the web manifest's icons
 * and the home-screen icon iOS wants. Painted here, once per size, from the
 * same two colours the SVG uses, so every icon of the forge is one shape.
 */

import { encodePng } from "./image/png.ts";

const FROM = [0x25, 0x63, 0xeb] as const; // accent
const TO = [0x7c, 0x3a, 0xed] as const; // merged

export type MarkShape =
  /** The favicon's shape: a rounded square with a margin, on nothing. */
  | "icon"
  /** Edge to edge, for a platform that masks its own shape (maskable, iOS). */
  | "full";

const cache = new Map<string, Uint8Array>();

/** Signed distance from a point to a rounded rectangle, positive outside. */
function roundedRect(
  px: number,
  py: number,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): number {
  const cx = Math.max(x + r, Math.min(px, x + w - r));
  const cy = Math.max(y + r, Math.min(py, y + h - r));
  return Math.hypot(px - cx, py - cy) - r;
}

/** The mark at `size` pixels, as PNG bytes. */
export function markPng(size: number, shape: MarkShape = "icon"): Uint8Array {
  const key = `${shape}:${size}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const rgba = new Uint8Array(size * size * 4);
  // The favicon is a 26/32 square with an 8/32 radius, inset by 3/32.
  const inset = shape === "icon" ? (size * 3) / 32 : 0;
  const side = size - inset * 2;
  const radius = shape === "icon" ? (size * 8) / 32 : 0;
  const SS = 4; // supersamples per axis for the edge
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let covered = 0;
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          if (roundedRect(px, py, inset, inset, side, side, radius) <= 0)
            covered++;
        }
      const a = covered / (SS * SS);
      if (a === 0) continue;
      // The gradient runs corner to corner, like the SVG's x1 y1 → x2 y2.
      const t = Math.min(1, Math.max(0, (x + y) / (2 * (size - 1))));
      const i = (y * size + x) * 4;
      rgba[i] = Math.round(FROM[0] + (TO[0] - FROM[0]) * t);
      rgba[i + 1] = Math.round(FROM[1] + (TO[1] - FROM[1]) * t);
      rgba[i + 2] = Math.round(FROM[2] + (TO[2] - FROM[2]) * t);
      rgba[i + 3] = Math.round(255 * a);
    }
  }
  const png = encodePng(size, size, rgba);
  cache.set(key, png);
  return png;
}
