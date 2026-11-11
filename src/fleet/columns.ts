/**
 * The fleet table's columns, one set per kind, and its one-column sort:
 * shared by the web page (`web/fleet-table.ts`) and the terminal screen
 * (`tui/screens/fleet.ts`), so both doors show the same rows the same way.
 */

import type { FleetRow } from "./rows.ts";
import type { FleetKind } from "./selection.ts";

export interface Column {
  readonly key: string;
  readonly label: string;
  readonly num?: boolean;
}

export const COLUMNS: Record<FleetKind, readonly Column[]> = {
  repo: [
    { key: "repo", label: "repository" },
    { key: "autonomy", label: "autonomy" },
    { key: "visibility", label: "visibility" },
    { key: "app", label: "app" },
  ],
  run: [
    { key: "created", label: "started" },
    { key: "repo", label: "repository" },
    { key: "kind", label: "kind" },
    { key: "agent", label: "agent" },
    { key: "state", label: "state" },
    { key: "cost", label: "cost", num: true },
  ],
  issue: [
    { key: "repo", label: "repository" },
    { key: "number", label: "#", num: true },
    { key: "title", label: "title" },
    { key: "state", label: "state" },
    { key: "assignee", label: "assignee" },
  ],
};

export interface Sort {
  readonly key: string;
  readonly descending: boolean;
}

/** `<column>` or `-<column>`; anything else keeps the selection's order. */
export function readSort(kind: FleetKind, text: string | null): Sort | undefined {
  if (text === null) return undefined;
  const descending = text.startsWith("-");
  const key = descending ? text.slice(1) : text;
  return COLUMNS[kind].some((c) => c.key === key) ? { key, descending } : undefined;
}

/** The sort as `?sort=` writes it. */
export const sortText = (sort: Sort): string => `${sort.descending ? "-" : ""}${sort.key}`;

/** The rows in the sort's order; a copy, the input is left alone. Ties keep their order. */
export function sortRows(rows: readonly FleetRow[], sort: Sort | undefined): FleetRow[] {
  const out = [...rows];
  if (sort === undefined) return out;
  const sign = sort.descending ? -1 : 1;
  out.sort((a, b) => {
    const x = a[sort.key] ?? "";
    const y = b[sort.key] ?? "";
    const by =
      typeof x === "number" && typeof y === "number"
        ? x - y
        : String(x).localeCompare(String(y));
    return sign * by;
  });
  return out;
}

/** A cell as text: cost in dollars, everything else as it is. */
export function cellText(column: Column, row: FleetRow): string {
  const value = row[column.key];
  return column.key === "cost" && typeof value === "number"
    ? `$${value.toFixed(2)}`
    : String(value ?? "");
}
