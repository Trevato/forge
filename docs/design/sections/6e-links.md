### 6e. Links that work

The cell buffer has a sixth plane, `link`, holding a 1-based index into the
frame's URI table — a URL is a property of a _run of cells_ exactly like a
colour, so it diffs with one integer compare and OSC 8 falls out of the same
emit loop that already does SGR deltas. Every open carries `id=`, because a
diff renderer paints dirty runs and one logical link routinely reaches the
terminal as several disjoint spans. Links are closed **before every cursor
jump and at the end of every row**: OSC 8 and SGR are independent, so the
frame-final SGR reset does not close one.

URLs are marked in the connect screens, the repo home's clone lines, the
"page" fact and rendered markdown. And because **no control sequence exists
that means "open this in the reader's browser"** — OSC 8 marks text clickable
and the person clicks — `O`/`o` does three things at once when it cannot open
one: copies the URL through OSC 52, and pushes the **link dialog**, which
shows the address plain with **mouse reporting turned off** for as long as it
is open, so the terminal's own drag-to-select works without Shift; `c` copies
again, `enter` tries the browser, `esc` puts the mouse back. It really opens
on the local stdio session, and over SSH from this machine's own address
(`sshTerminal.local`), because then the browser is on the same screen. Four
routes to one URL (the hyperlink, the clipboard, the selectable text, the
opener), because none of them is reliable on its own.
