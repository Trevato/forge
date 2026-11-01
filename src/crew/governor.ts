/**
 * The inflow governor (#6374, #7644): build slots fall while pulls open
 * faster than they land, and rise as the pile drains. Pure: one repository's
 * flow and the operator's ceiling in, `{ slots, why }` out. The picker reads
 * it through `governed.ts` (#6375).
 *
 * Two brakes, each scaled to how far past its line the repository is; the
 * stronger wins. Both react to pulls opened faster than they land, never to
 * silence: an hour with nothing opened cannot lower the slots.
 *
 * Neither brakes until the hour opened at least LAG more than it landed:
 * one pull per builder, and never under PILE_MIN / 2. A pull lands about an
 * hour after it opens, so a crew rising from 1 to its ceiling opens up to
 * ceiling − 1 more than it lands that hour by lag alone; braking on that
 * swung the slots 5, 1, 5, 1 and held one builder at 1 over a pile (#7712).
 *
 * - Inflow: more than 1.5× as many opened as landed in the last hour and over
 *   six, and the six hours left at least PILE_MIN more open than they closed.
 * - Pile: at least PILE_MIN pulls moving, more than 3× the hour's landings.
 *   Only moving pulls count
 *   (`repo_flow.ts`): a red or long-untouched pull is parked, and a parked
 *   pile no builder is working cannot hold the builders down.
 *
 * From one builder the brakes let go as soon as it lands what it opens, so
 * a slow hour cannot trap the crew at one.
 */

import type { RepoFlow } from "../flow/repo_flow.ts";

export const INFLOW_RATIO = 1.5;
export const PILE_RATIO = 3;
export const PILE_MIN = 10;

/** The hour's excess (opened − landed) below which neither brake acts at `ceiling`. */
export const lag = (ceiling: number): number => Math.max(ceiling, PILE_MIN / 2);

export interface Governed {
  readonly slots: number;
  /** One plain sentence; says nothing is held back at the ceiling. */
  readonly why: string;
}

/** Slots in 1..ceiling (0 when the ceiling is 0) for `flow`. */
export function governedSlots(flow: RepoFlow, ceiling: number): Governed {
  const top = Number.isFinite(ceiling) ? Math.max(0, Math.floor(ceiling)) : 0;
  // At 0 or 1 there is nothing to hold back; the final clamp to 1 below is for ceilings of 2 and up.
  if (top <= 1) return { slots: top, why: `Builders ${top}: nothing to hold back` };
  const { open, moving, opened1h, landed1h, opened6h, landed6h } = flow;
  let slots = top;
  let why =
    opened1h === 0 && landed1h === 0
      ? `Builders ${top}: a quiet hour, ${moving} of ${open} open pulls moving`
      : `Builders ${top}: ${opened1h} opened, ${landed1h} landed last hour, ${moving} of ${open} open pulls moving`;

  const flooding = opened1h - landed1h >= lag(top);

  if (
    flooding &&
    opened1h > INFLOW_RATIO * landed1h &&
    opened6h > INFLOW_RATIO * landed6h &&
    opened6h - landed6h >= PILE_MIN
  ) {
    const n = Math.floor((top * INFLOW_RATIO * landed1h) / opened1h);
    if (n < slots) {
      slots = n;
      why = `Builders ${top} → ${Math.max(1, n)}: ${opened1h} opened vs ${landed1h} landed last hour`;
    }
  }
  if (flooding && moving >= PILE_MIN && moving > PILE_RATIO * landed1h) {
    const n = Math.floor((top * PILE_RATIO * landed1h) / moving);
    if (n < slots) {
      slots = n;
      why = `Builders ${top} → ${Math.max(1, n)}: ${moving} pulls moving, ${opened1h} opened vs ${landed1h} landed last hour`;
    }
  }
  return { slots: Math.max(1, Math.min(top, slots)), why };
}
