/**
 * JSON Lines (.jsonl, .ndjson) as the same plain table the CSV parser makes:
 * one object per line, the columns the union of the keys of the first
 * thousand objects in first-seen order. A line that does not parse is one row
 * that says so, with its line number; the rest of the file still reads.
 */

import type { Parsed } from "./csv-parse.ts";

/** Objects whose keys make the columns. */
export const KEY_WINDOW = 1_000;

/** A cell: strings as they are, null empty, nested values as compact JSON. */
const cell = (v: unknown): string =>
  v === null || v === undefined ? "" : typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);

type Line = { readonly n: number; readonly value: Record<string, unknown> } | { readonly n: number; readonly bad: string };

export function parseJsonl(input: string, keepRows: number, maxColumns = Infinity): Parsed {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const keys = new Map<string, number>();
  const kept: Line[] = [];
  let objects = 0;
  let records = 0;
  let n = 0;
  let pos = 0;
  while (pos <= text.length) {
    let end = text.indexOf("\n", pos);
    if (end === -1) end = text.length;
    n++;
    const raw = text.slice(pos, end).trim();
    pos = end + 1;
    if (raw === "") continue;
    records++;
    const keeping = kept.length < keepRows;
    const needKeys = objects < KEY_WINDOW;
    if (!keeping && !needKeys) continue;
    let line: Line;
    try {
      const v: unknown = JSON.parse(raw);
      line =
        v !== null && typeof v === "object" && !Array.isArray(v)
          ? { n, value: v as Record<string, unknown> }
          : { n, bad: `Line ${n}: not a JSON object` };
    } catch {
      line = { n, bad: `Line ${n}: not valid JSON` };
    }
    if ("value" in line && needKeys) {
      objects++;
      for (const k of Object.keys(line.value)) if (!keys.has(k)) keys.set(k, keys.size);
    }
    if (keeping) kept.push(line);
  }
  if (records === 0) return { error: "The file has no rows." };
  // Only the columns the page can draw are built; `columns` stays the true count.
  const all = keys.size > 0 ? [...keys.keys()] : ["line"];
  const header = all.slice(0, maxColumns);
  const rows: string[][] = [header];
  for (const line of kept) {
    if ("bad" in line) rows.push([line.bad]);
    else rows.push(header.map((k) => (Object.hasOwn(line.value, k) ? cell(line.value[k]) : "")));
  }
  return { delimiter: ",", rows, columns: all.length, records: records + 1 };
}
