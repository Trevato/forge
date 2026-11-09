# CSV and TSV as a table

`.csv`/`.tsv` files open as a table on the blob page (`src/web/render/csv.ts`, parser in `csv-parse.ts`).
RFC 4180 with quotes, embedded newlines, doubled quotes and a BOM; the delimiter (`,` `;` tab `|`) is detected from the first record.
The first 1,000 rows are drawn on the server with a sticky header and (on phones) a sticky first column; numeric columns are right-aligned.
`?all=1` ("Show all N rows", no JavaScript needed) draws up to 20,000. The header line shows rows × columns and the delimiter.
A small script adds sort (header click or Enter) and a filter box over the rows drawn; no library.
A file that is not valid CSV shows the source with a one-line reason. `?view=source`, Raw and Download work as for any file.

## JSON Lines

`.jsonl`/`.ndjson` files use the same table (`src/web/render/jsonl-parse.ts` makes the rows; `csv.ts` draws them).
- Columns are the union of the keys of the first 1,000 objects, in first-seen order; a key first seen later is not a column.
- Strings show as they are, `null` as empty, nested values as compact JSON; everything is escaped.
- A line that does not parse is one row, `Line N: not valid JSON`, or `Line N: not a JSON object` for valid JSON that is not an object (N counts physical lines). The rest of the file still renders.
- The header line says `JSON Lines` in place of the delimiter. A file with no non-blank lines falls back to the source view.
- At most 200 columns are drawn; the page says how many there are.
