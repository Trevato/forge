/**
 * A panel's current value as one short string: the number the page draws
 * large on a number chart — the last group of the panel's rows, through
 * `formatValue`. Read through `panelData`, the one door the page reads, so
 * the card and the page cannot disagree. Plain data in, a string out.
 */
import type { Database } from "bun:sqlite";
import { formatValue } from "./chart.ts";
import { panelData } from "./panel_data.ts";
import type { Board, Panel } from "./store.ts";

export function panelNow(db: Database, board: Board, panel: Panel, now = Date.now()): string {
  const data = panelData(db, board, panel, {}, now);
  if (!data.ok) return "unavailable";
  const last = data.rows[data.rows.length - 1];
  return last === undefined ? "no data" : formatValue(last.value ?? 0);
}
