# Font specimens

Open a `.ttf`, `.otf`, `.woff` or `.woff2` file in a repository and the blob page draws a specimen (`src/web/render/font.ts`): the family name, then the alphabet, digits and a pangram at three sizes, set in the font itself. Detection is by magic bytes, so a renamed non-font stays an ordinary file.

The family comes from the `name` table of a TrueType/OpenType file (bounds-checked, escaped); a WOFF file compresses its tables, so it is named by its file name. A small script loads the font through `FontFace` from the same-origin media route; without script the specimen shows in the page's own face. Only this page's policy gains `font-src 'self'` (never `data:`), on first and kept renders alike. `?view=source`, Raw and Download show the bytes untouched.

Terminal (SSH): there is no screen for it. A terminal draws in its own fixed face and cannot load a font, so a specimen would show nothing the file view does not; the file view lists it as a binary file with its size.
