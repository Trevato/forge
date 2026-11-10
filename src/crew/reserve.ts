/**
 * The standing reserve: how much startable work the planner keeps on the
 * map, so builders never wait between waves for it (#3237). Two issues per
 * builder slot, never fewer than a thin map's three. The autonomy tick asks
 * the planner whenever startable work is below it, the planner's brief
 * names it, and the tick line says it as `reserve=startable/target`.
 */

/** The map is thin below this many startable issues, whatever the slots. */
export const THIN_MAP = 3;
/** Startable issues the planner keeps per builder slot. */
export const RESERVE_PER_SLOT = 2;

/** The reserve for a repository with this many builder slots. */
export function reserveTarget(slots: number): number {
  return Math.max(THIN_MAP, RESERVE_PER_SLOT * Math.max(0, slots));
}

/** What the planner is told and the tick line says: startable against the target. */
export interface Reserve {
  readonly startable: number;
  readonly target: number;
}

export function reserveOf(startable: number, slots: number): Reserve {
  return { startable, target: reserveTarget(slots) };
}

/** `5/14`: the tick line's form. */
export function reserveWords(reserve: Reserve): string {
  return `${reserve.startable}/${reserve.target}`;
}

/** Whether the reserve is short: the planner is owed a pass. */
export function short(reserve: Reserve): boolean {
  return reserve.startable < reserve.target;
}

/**
 * Whether the planner is owed a pass: the reserve is down to half its
 * target. Asked at one below the target, the planner ran every twenty
 * minutes to open one issue each time, and a pass costs the same to set up
 * whether it opens one issue or five (2026-11-09: 11 passes in four hours,
 * most a top-up of one). Half lets the map run down between passes and
 * fills it back in one; a thin map's three is still asked at two.
 */
export function due(reserve: Reserve): boolean {
  return reserve.startable <= Math.ceil(reserve.target / 2);
}
