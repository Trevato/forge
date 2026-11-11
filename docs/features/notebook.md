# Jupyter notebooks

A `.ipynb` file opens on the blob page as its cells and saved outputs (`src/web/render/notebook.ts`). Nothing is run.
Markdown cells go through the forge's Markdown renderer. A code cell is a `pre` headed `In [n]:` with its execution count. Output text (streams, plain text, errors with their colour codes removed) is escaped text. PNG and JPEG outputs are pictures, drawn only when the base64 is well-formed, and shrink to fit a phone. HTML and script outputs are shown as escaped text and never inserted or run. Other output kinds are skipped.
A notebook over 1 MB, one that is not valid JSON, or one with no `cells` list shows the ordinary source view with one line saying why. At most 2,000 cells, and 2,000 outputs per cell, are drawn. `?view=source`, Raw and Download show the bytes untouched.
The terminal (SSH) file view has no notebook reader: it shows the file as plain text, the JSON itself, escaped like any text file. Nothing in it is run there either. Reading cells in the terminal is left out. Classes live in `docs/design/areas/render.md`.
