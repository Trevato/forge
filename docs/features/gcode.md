# G-code layers

A sliced `.gcode` (or `.gco`) file opens in the file view as its toolpath, one layer at a time. The drawing is SVG made on the server from numbers only; nothing in the file's text reaches the page.

## On the web

Open the file. **Previous** and **Next** step through the layers; the box jumps to one (`?layer=N`, so the URL reproduces the view). Solid lines extrude, faint lines travel. Under the drawing: layers, bounding box (mm), filament used (mm of filament) and the slicer's own time estimate when the file states one.

- A number past the last layer shows the last; anything that is not a whole number shows layer 1.
- A layer with more than 20,000 moves draws the first 20,000 and says so.
- Over 50 MB the layers are not drawn: the page says it is G-code and how big, and offers Download.
- Files over 256 KB are parsed on a worker thread, and the parse is kept for the next page of the same file. If the worker cannot answer, the page says to try again.

## What is read

G0/G1 moves (G2/G3 as the straight line to their endpoint), G90/G91, M82/M83 and G92. A move that extrudes (E goes forward while X or Y changes) belongs to the layer of its Z, rounded to a micron.

Filament is the forward travel of E; a retraction's rewind is paid back before more forward travel counts, so retract 1 mm and unretract 1 mm adds nothing.

**Units are millimetres.** G21 is the slicer default; a file in inches (G20) is not converted, and its numbers are drawn as if they were millimetres.

## In the terminal

Open the file from a repository in `forge` over SSH: it shows the same facts as a table (layers, bounding box, filament, estimated time). The layer drawing is a web view.
