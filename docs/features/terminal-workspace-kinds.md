# Notebooks, JSON Lines and logs in the terminal

The SSH workspace opens `.ipynb`, `.jsonl`/`.ndjson` and `.log`/`.ansi` files the way the blob page does, from the same parsers (`parseNotebook` in `src/web/render/notebook.ts`, `parseJsonl`, `ansiLines`, `logLevel` in `src/web/render/log.ts`). Drawing lives in `src/tui/screens/workspace_kinds.ts`.

- **Notebook**: cells in order. Markdown keeps its source lines (headings bold), code is dimmed as `In [n]: …`, outputs are text, errors are red, images say `[image output not shown]`. Nothing is run.
- **JSON Lines**: a table, one row per object; a bad line is a row that names its line number.
- **Log**: SGR colours from the file are kept; a line with none is coloured by the level it states first (after an optional timestamp): `ERROR`, `[warn]`, `level=error`. Prose such as "no errors found" is not coloured. Escapes and control characters are never passed to the terminal.

Press `s` to flip between the view and the source text; the footer names the other view. In edit mode the source is always shown.

Limits, always said on screen: a JSON Lines table shows the first 500 rows and ends with "N more rows not shown"; a notebook or log shows 10,000 lines and ends with "N more lines not shown". A notebook is cut at 2,000 cells with "N more cells not shown".

Fallback: a file that is not valid JSON (notebook), has no cell list, or has no JSON object lines (jsonl) has no view and opens as source, as it always did. An empty log is empty.
