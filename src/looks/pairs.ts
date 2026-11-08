/**
 * How many of a pull's pages sit beside a picture of main, and how many are
 * new to the pull: one count, read by the pull page and the terminal screen.
 * Plain data in, plain data out; it reads nothing.
 */

import type { Look, LookKind } from "../core/looks.ts";

export interface PairCounts {
  /** Pages the head pictures. */
  readonly pages: number;
  /** Of those, pages main has a light picture of at a width the head shows. */
  readonly beside: number;
  /** Pages main has no picture of. */
  readonly fresh: number;
  /** Whether main has no picture at all. */
  readonly mainEmpty: boolean;
}

const WIDTHS: readonly LookKind[] = ["phone", "desktop"];

/** `taken`: the head's light, forge-taken looks; `mainLooks`: main's the reader may fetch. */
export function pairCounts(
  taken: readonly Look[],
  mainLooks: readonly Look[],
): PairCounts {
  const ok = (l: Look, page: string, kind: LookKind): boolean =>
    l.page === page && l.kind === kind && l.error === null;
  const pages = [...new Set(taken.map((l) => l.page))].filter((page) =>
    WIDTHS.some((k) => taken.some((l) => ok(l, page, k))),
  );
  const beside = pages.filter((page) =>
    WIDTHS.some(
      (k) =>
        taken.some((l) => ok(l, page, k)) &&
        mainLooks.some((l) => l.theme === "light" && ok(l, page, k)),
    ),
  ).length;
  return {
    pages: pages.length,
    beside,
    fresh: pages.length - beside,
    mainEmpty: mainLooks.length === 0,
  };
}

/** The one line over a pull's pictures; none when the head has no picture. */
export function pairsLine(c: PairCounts): string | undefined {
  if (c.pages === 0) return undefined;
  if (c.beside === 0 && c.mainEmpty) return "main has no pictures yet.";
  const n = `${c.beside} page${c.beside === 1 ? "" : "s"}`;
  return `${n} beside main · ${c.fresh} new to this pull`;
}
