/**
 * The inflow governor (#6374): build slots fall while pulls open faster than
 * they land, and rise as the pile drains. Pure: the flow vitals and the
 * operator's ceiling in, `{ slots, why }` out. The picker reads it through `governed.ts` (#6375).
 *
 * Two pressures, each scaled to how far past its line the forge is; the
 * stronger wins. Vitals carry a 1 h and a 6 h window, so "stayed above 1.5×
 * for 2 h" reads as both windows above it: the last hour, and the six-hour
 * average. A pile of fewer than PILE_MIN open pulls is never a pile.
 */

import type { Vitals } from "../flow/vitals.ts";

export const INFLOW_RATIO = 1.5;
export const PILE_RATIO = 3;
export const PILE_MIN = 10;

export interface Governed {
  readonly slots: number;
  /** One plain sentence; says nothing is held back at the ceiling. */
  readonly why: string;
}

/** Slots in 1..ceiling (0 when the ceiling is 0) for `vitals`. */
export function governedSlots(vitals: Vitals, ceiling: number): Governed {
  const top = Number.isFinite(ceiling) ? Math.max(0, Math.floor(ceiling)) : 0;
  // At 0 or 1 there is nothing to hold back; the final clamp to 1 below is for ceilings of 2 and up.
  if (top <= 1) return { slots: top, why: `Builders ${top}: nothing to hold back` };
  const { open, opened1h, landed1h, opened6h, landed6h } = vitals;
  let slots = top;
  let why = `Builders ${top}: ${opened1h} opened, ${landed1h} landed last hour, ${open} open`;

  if (opened1h > INFLOW_RATIO * landed1h && opened6h > INFLOW_RATIO * landed6h) {
    const n = Math.floor((top * INFLOW_RATIO * landed1h) / opened1h);
    if (n < slots) {
      slots = n;
      why = `Builders ${top} → ${Math.max(1, n)}: ${opened1h} opened vs ${landed1h} landed last hour`;
    }
  }
  if (open >= PILE_MIN && open > PILE_RATIO * landed1h) {
    const n = Math.floor((top * PILE_RATIO * landed1h) / open);
    if (n < slots) {
      slots = n;
      why = `Builders ${top} → ${Math.max(1, n)}: ${open} open vs ${landed1h} landed last hour`;
    }
  }
  return { slots: Math.max(1, Math.min(top, slots)), why };
}
