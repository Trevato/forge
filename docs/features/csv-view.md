# CSV and TSV as a table

`.csv`/`.tsv` files open as a table on the blob page (`src/web/render/csv.ts`, parser in `csv-parse.ts`).
RFC 4180 with quotes, embedded newlines, doubled quotes and a BOM; the delimiter (`,` `;` tab `|`) is detected from the first record.
The first 1,000 rows are drawn on the server with a sticky header and (on phones) a sticky first column; numeric columns are right-aligned.
`?all=1` ("Show all N rows", no JavaScript needed) draws up to 20,000. The header line shows rows × columns and the delimiter.
A small script adds sort (header click or Enter) and a filter box over the rows drawn; no library.
A file that is not valid CSV shows the source with a one-line reason. `?view=source`, Raw and Download work as for any file.
