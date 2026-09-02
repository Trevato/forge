/**
 * Rects and a two-pass constraint splitter — ratatui's model without its
 * cassowary solver, which is 1–2k lines by itself and buys nothing when every
 * layout in the app is one or two nested splits.
 *
 * Padding and borders live in the widget (`box()` returns its inner Rect),
 * never here. That is the whole box model, and it composes.
 */

import type { Rect } from "../term/screen.ts";

export type { Rect };

export type Constraint =
  | { readonly k: "len"; readonly v: number } // exactly v cells
  | { readonly k: "min"; readonly v: number } // at least v
  | { readonly k: "pct"; readonly v: number } // v% of the total
  | { readonly k: "fill"; readonly v: number }; // share the remainder, weighted

export const len = (v: number): Constraint => ({ k: "len", v });
export const min = (v: number): Constraint => ({ k: "min", v });
export const pct = (v: number): Constraint => ({ k: "pct", v });
export const fill = (v = 1): Constraint => ({ k: "fill", v });

/**
 * Split `area` along `dir` into one Rect per constraint.
 *
 * Pass 1 assigns `len` and `pct` (floored) and gives `min` its floor. Pass 2
 * distributes the remainder across `fill` weights with largest-remainder
 * rounding, so the segments always sum to exactly the available size — an
 * off-by-one here is the one-column gap that only appears at odd widths.
 */
export function split(
  area: Rect,
  dir: "h" | "v",
  cs: readonly Constraint[],
): Rect[] {
  const total = dir === "h" ? area.w : area.h;
  const n = cs.length;
  if (n === 0) return [];
  const sizes = new Array<number>(n).fill(0);

  let used = 0;
  let fillWeight = 0;
  for (let i = 0; i < n; i++) {
    const c = cs[i]!;
    if (c.k === "len") sizes[i] = Math.max(0, c.v);
    else if (c.k === "pct")
      sizes[i] = Math.max(0, Math.floor((total * c.v) / 100));
    else if (c.k === "min") sizes[i] = Math.max(0, c.v);
    else fillWeight += Math.max(0, c.v);
    used += sizes[i]!;
  }

  let free = total - used;
  if (free > 0 && fillWeight > 0) {
    // Largest-remainder: hand out the floors, then the leftover cells to the
    // segments whose fractional parts were biggest.
    const share: number[] = [];
    let handed = 0;
    for (let i = 0; i < n; i++) {
      const c = cs[i]!;
      if (c.k !== "fill") {
        share.push(-1);
        continue;
      }
      const exact = (free * Math.max(0, c.v)) / fillWeight;
      const floor = Math.floor(exact);
      sizes[i] = floor;
      handed += floor;
      share.push(exact - floor);
    }
    let extra = free - handed;
    while (extra > 0) {
      let best = -1;
      for (let i = 0; i < n; i++)
        if (share[i]! >= 0 && (best === -1 || share[i]! > share[best]!))
          best = i;
      if (best === -1) break;
      sizes[best] = sizes[best]! + 1;
      share[best] = -1;
      extra--;
    }
    free = 0;
  } else if (free < 0) {
    // Over-committed: shrink from the end down to zero. Better a clipped
    // last pane than a negative Rect propagating into every draw call.
    for (let i = n - 1; i >= 0 && free < 0; i--) {
      const take = Math.min(sizes[i]!, -free);
      if (take > 0) {
        sizes[i] = sizes[i]! - take;
        free += take;
      }
    }
  }

  const out: Rect[] = [];
  let cursor = dir === "h" ? area.x : area.y;
  for (let i = 0; i < n; i++) {
    const s = Math.max(0, sizes[i]!);
    out.push(
      dir === "h"
        ? { x: cursor, y: area.y, w: s, h: area.h }
        : { x: area.x, y: cursor, w: area.w, h: s },
    );
    cursor += s;
  }
  return out;
}

/** Shrink a Rect by equal padding on each side (clamped to non-negative). */
export function inset(r: Rect, dx: number, dy = dx): Rect {
  return {
    x: r.x + dx,
    y: r.y + dy,
    w: Math.max(0, r.w - dx * 2),
    h: Math.max(0, r.h - dy * 2),
  };
}

/** A w×h Rect centred inside `r`, clamped to fit. */
export function center(r: Rect, w: number, h: number): Rect {
  const cw = Math.min(w, r.w);
  const ch = Math.min(h, r.h);
  return {
    x: r.x + ((r.w - cw) >> 1),
    y: r.y + ((r.h - ch) >> 1),
    w: cw,
    h: ch,
  };
}

export function contains(r: Rect, x: number, y: number): boolean {
  return x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
}
