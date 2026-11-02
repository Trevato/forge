/**
 * CSV and TSV, per RFC 4180: quoted fields, `""` for a quote inside one,
 * newlines inside quotes, CRLF, and a delimiter sniffed from the first line.
 *
 * Plain text in, plain data out. Rows past `maxRows` are counted, never
 * built, so a huge file costs one pass and a bounded amount of memory.
 * A file that does not parse comes back with `error` saying which line broke;
 * `header` and `rows` then hold whatever was read before it.
 */

export type Delimiter = "," | ";" | "\t";

export interface CsvError {
  /** 1-based line in the source where the problem is. */
  readonly line: number;
  readonly message: string;
}

export interface Table {
  readonly header: string[];
  readonly rows: string[][];
  /** Data rows past the cap: counted, not parsed. */
  readonly more: number;
  readonly delimiter: Delimiter;
  /** The widest record's field count, before `maxColumns` cut it. */
  readonly columns: number;
  readonly error?: CsvError;
}

export interface CsvOptions {
  /** Data rows kept, header excluded. @default 1000 */
  readonly maxRows?: number;
  /** Fields kept per record; the rest are counted, not stored. @default MAX_COLUMNS */
  readonly maxColumns?: number;
  /** Skip the sniff. */
  readonly delimiter?: Delimiter | undefined;
}

/** Fields kept per record unless the caller says otherwise. */
export const MAX_COLUMNS = 64;

const CANDIDATES: readonly Delimiter[] = [",", ";", "\t"];

/** The delimiter that appears most, outside quotes, on the first line. */
export function sniffDelimiter(text: string): Delimiter {
  const counts = new Map<Delimiter, number>();
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === "\n" || ch === "\r")) break;
    else if (!quoted && (ch === "," || ch === ";" || ch === "\t"))
      counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let best: Delimiter = ",";
  let most = 0;
  for (const d of CANDIDATES) {
    const n = counts.get(d) ?? 0;
    if (n > most) {
      best = d;
      most = n;
    }
  }
  return best;
}

export function parseCsv(input: string, options: CsvOptions = {}): Table {
  const maxRows = Math.max(0, Math.floor(options.maxRows ?? 1000));
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const maxColumns = Math.max(1, Math.floor(options.maxColumns ?? MAX_COLUMNS));
  const delimiter = options.delimiter ?? sniffDelimiter(text);

  const records: string[][] = [];
  let more = 0;
  let row: string[] = [];
  let fields = 0; // fields in this record, kept or not
  let columns = 0;
  let field = "";
  let quoted = false;
  let touched = false; // the field has had a character, kept or not
  let closed = false; // just left a quoted field: only a delimiter or newline may follow
  let line = 1;
  let quoteLine = 1;
  let error: CsvError | undefined;

  // The header and `maxRows` data rows are kept; after that fields are not
  // even accumulated, only the records are counted.
  const keep = (): boolean =>
    records.length < maxRows + 1 && row.length < maxColumns;
  const endField = (): void => {
    if (row.length < maxColumns) row.push(field);
    fields++;
    field = "";
    closed = false;
  };
  const endRecord = (): void => {
    endField();
    columns = Math.max(columns, fields);
    fields = 0;
    const blank = row.length === 1 && row[0] === "" && !touched;
    touched = false;
    if (!blank) {
      if (records.length < maxRows + 1) records.push(row);
      else more++;
    }
    row = [];
  };

  for (let i = 0; i < text.length && error === undefined; i++) {
    const ch = text[i]!;
    if (quoted) {
      touched = true;
      if (ch === '"') {
        if (text[i + 1] === '"') {
          if (keep()) field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else {
        // A bare `\r` ends a line in old files, so it counts like `\n`.
        if (ch === "\n" || (ch === "\r" && text[i + 1] !== "\n")) line++;
        if (keep()) field += ch;
      }
      continue;
    }
    if (ch === delimiter) endField();
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRecord();
      line++;
    } else if (closed)
      error = { line, message: "text after a closing quote" };
    else if (ch === '"') {
      if (field === "") {
        quoted = true;
        touched = true;
        quoteLine = line;
      } else error = { line, message: "a quote inside an unquoted field" };
    } else {
      touched = true;
      if (keep()) field += ch;
    }
  }

  if (error === undefined && quoted)
    error = { line: quoteLine, message: "a quoted field is never closed" };
  if (error === undefined && (fields > 0 || touched))
    endRecord();

  const [header = [], ...rows] = records;
  return {
    header,
    rows,
    more,
    delimiter,
    columns,
    ...(error === undefined ? {} : { error }),
  };
}
