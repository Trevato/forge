### 6·0a·1. Laid out for the terminal it is in

Three numbers in `ui/layout.ts` decide every screen's shape, so every screen
folds at the same width and none invents its own. At **100 columns** a list
sits beside its detail; below, `beside()` stacks the two with the detail
underneath (two fifths of the height unless the screen says otherwise), and
drops it only when there are fewer than twelve rows to share. Under **40×10**
no layout survives — a card is narrower than its title — so one line says what
would help, and every screen keeps its state for the moment the window grows.

A resize re-lays the current screen at once and loses nothing: a list keeps
its cursor and scrolls it back into view, a log keeps the _line_ at the top
of the reader's window whatever number of rows it now wraps to, and a program
holding the pty (`$FORGE_EDITOR`, an app's `tty`) hears the new size before
the UI does. Long text wraps or ends in an ellipsis at the width, never past
it. A row's meta gives way before its title starves — the leading pieces
(`metaOf` order: a commit, then a cost, then the time) go first, the last one
last — and a table's ranked columns (`drop`) are given up lowest first, the
same word `local/rows.ts` uses.

An activity row is one line, not two, because a row is a thing you can put a
cursor on: `who did what · the object`, with the time in a fixed right-hand
column. The headline already ends with `#4`, so the object drops the repeated
number rather than truncating the title.
