### 6c. Editing, and the commit dialog

`e` turns the active tab into a modeless editor: arrows/Home/End/PgUp/PgDn and
word jumps, shift-arrows to select, `ctrl+c`/`x`/`v` (which also mirror to
_your_ clipboard over OSC 52), `ctrl+z`/`ctrl+y`, `ctrl+f` find, `ctrl+r`
replace, horizontal scrolling with no soft wrap, tabs rendered at 4 and kept as
tabs. The status row reads `path · Ln 12, Col 4 · modified`.

Four rules are non-negotiable because this is attached to a git host: CRLF, a
BOM and the presence or absence of a trailing newline round-trip exactly;
nothing is normalised silently. Past 1 MB or 50k lines the buffer opens
read-only and says which, rather than being slow.

`c` (or `ctrl+s` from inside the buffer) opens the commit dialog. It lists
**every** change the workspace is holding — each modified tab and each pending
deletion, ticked, marked `+` added, `~` edited, `-` deleted — then asks the
three questions `editFiles` takes: message (subject, optional body), target
(`current branch` or `new branch`, defaulting to **new**, named
`<you>/edit-<file>`), and `[ ] open a pull request` with the title prefilled
from the subject. One call: no half-finished state (a branch with no commit, a
commit with no pull) can be invented. On success the workspace follows the
commit — the ref pill becomes the new branch and every tab is re-read from it.
**A refused commit keeps every buffer**, and says why on the dialog: a
protected branch, a name git will not take, an origin that said no.

Where the change has nowhere to go — a reader without write access, a live
browse of a repository nobody has offered you a route into — `e`, `c`, `n` and
`D` say so instead of opening something that could never land. Where it has a
route, they open the proposal dialog instead; §6c·1 is that route.
