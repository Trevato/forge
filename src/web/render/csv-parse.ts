/**
 * RFC 4180 as plain data: text in, rows out. Quoted fields, embedded
 * newlines, doubled quotes, a leading BOM, CRLF or LF. The delimiter is
 * detected from the first record. A file that cannot be read as a table says
 * why in one line instead of guessing.
 */

export const DELIMITERS = [",", ";", "\t", "|"] as const;
export type Delimiter = (typeof DELIMITERS)[number];

export interface Table {
  readonly delimiter: Delimiter;
  /** The first `rows` records, each cut to `columns` fields. */
  readonly rows: string[][];
  /** The widest record in the whole file, kept or not. */
  readonly columns: number;
  /** Every record in the file, the header included. */
  readonly records: number;
}

export type Parsed = Table | { readonly error: string };

/** What to keep. The rest of the file is still scanned, only counted. */
export interface Limits {
  /** Records kept whole (default: all). */
  readonly rows?: number;
  /** Fields kept per record (default: all). */
  readonly columns?: number;
  readonly delimiter?: Delimiter;
}

/** Each candidate delimiter's count in the first record, quotes respected. */
export function detectDelimiter(text: string): Delimiter {
  const counts = new Map<string, number>();
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') quoted = !quoted;
    else if (!quoted && (c === "\n" || c === "\r")) break;
    else if (!quoted) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  let best: Delimiter = ",";
  let most = 0;
  for (const d of DELIMITERS) {
    const n = counts.get(d) ?? 0;
    if (n > most) {
      best = d;
      most = n;
    }
  }
  return best;
}

export function parseCsv(input: string, limits: Limits = {}): Parsed {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const delimiter = limits.delimiter ?? detectDelimiter(text);
  const keepRows = limits.rows ?? Infinity;
  const keepCols = limits.columns ?? Infinity;
  const rows: string[][] = [];
  let row: string[] = [];
  let fields = 0;
  let records = 0;
  let columns = 0;
  let i = 0;
  const n = text.length;
  const keeping = (): boolean => records < keepRows;
  const addField = (value: string): void => {
    if (keeping() && fields < keepCols) row.push(value);
    fields++;
  };
  const endRow = (): void => {
    if (fields > columns) columns = fields;
    if (keeping()) rows.push(row);
    records++;
    row = [];
    fields = 0;
  };
  let field = "";
  while (i < n) {
    const c = text[i]!;
    if (c === '"' && field === "") {
      // A quoted field runs to its closing quote; "" inside is one quote.
      const wanted = keeping() && fields < keepCols;
      i++;
      for (;;) {
        const close = text.indexOf('"', i);
        if (close === -1) return { error: "A quoted field is never closed." };
        if (wanted) field += text.slice(i, close);
        if (text[close + 1] === '"') {
          if (wanted) field += '"';
          i = close + 2;
          continue;
        }
        i = close + 1;
        break;
      }
      const after = text[i];
      if (after !== undefined && after !== delimiter && after !== "\n" && after !== "\r")
        return { error: `Text follows a closing quote on row ${records + 1}.` };
    } else if (c === delimiter) {
      addField(field);
      field = "";
      i++;
    } else if (c === "\n" || c === "\r") {
      addField(field);
      field = "";
      endRow();
      i += c === "\r" && text[i + 1] === "\n" ? 2 : 1;
    } else {
      // Unquoted run up to the next special character.
      let j = i + 1;
      while (j < n) {
        const d = text[j]!;
        if (d === delimiter || d === "\n" || d === "\r") break;
        j++;
      }
      if (keeping() && fields < keepCols) field += text.slice(i, j);
      i = j;
    }
  }
  // A final record with no newline; a trailing newline adds none.
  if (n > 0 && text[n - 1] !== "\n" && text[n - 1] !== "\r") {
    addField(field);
    endRow();
  }
  if (records === 0 || columns === 0) return { error: "The file has no rows." };
  return { delimiter, rows, columns, records };
}

const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;

/** True for each column whose every non-empty cell, header aside, is a number. */
export function numericColumns(table: Table, columns = table.columns): boolean[] {
  const out: boolean[] = [];
  const end = table.rows.length;
  for (let c = 0; c < Math.min(columns, table.columns); c++) {
    let seen = 0;
    let ok = true;
    for (let r = 1; r < end && ok; r++) {
      const cell = (table.rows[r]![c] ?? "").trim();
      if (cell === "") continue;
      seen++;
      ok = NUMBER.test(cell);
    }
    out.push(ok && seen > 0);
  }
  return out;
}
