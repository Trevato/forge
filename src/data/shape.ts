/** A row as the object an editor wants: column → value. Plain data in, plain data out. */
export type Cell = string | number | null;

export function rowObject(columns: readonly string[], row: readonly Cell[]): Record<string, Cell> {
  const out: Record<string, Cell> = {};
  columns.forEach((c, i) => {
    out[c] = row[i] ?? null;
  });
  return out;
}

/** One line of a row, for a list: no newline or control byte can reach the terminal. */
export const cellLine = (v: Cell): string =>
  v === null ? "" : String(v).replace(/[\u0000-\u001f\u007f]+/g, " ");
