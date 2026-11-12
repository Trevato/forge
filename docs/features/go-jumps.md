# `g` then a letter: jump between pages (#10948)

Press `g`, then a letter within one second, from any page outside a field. Modifier keys (Ctrl, Cmd, Alt) cancel it, and in a text field `g` is just a letter.

| Keys | Page | Who |
|---|---|---|
| `g h` | Home | everyone |
| `g e` | Explore | everyone |
| `g f` | Flow | signed in |
| `g q` | Asks | signed in |
| `g t` | Talk | signed in |
| `g s` | System | admins |

- A page the viewer cannot open does nothing (no error, no redirect to sign-in): the script only knows the pages for the viewer's level.
- The table is `GO_PAGES` in `src/web/go_pages.ts`, the same list as the `:` prompt and Cmd/Ctrl K. A page gets a jump by giving it a `key` there; a test refuses a letter used twice. `?` lists the jumps the viewer has, read from that table.
- `g h`, `g q` and `g t` are the chords the top bar already wore (its hover hints show them), so they now work from anywhere and the sheet names them like the rest.
- Test: `test/keys-goto.test.ts` runs the real keys script against a fake document: stranger and user, the 1 s timeout, Ctrl/Meta, and a field.

**Terminal:** none added. Terminal screens are reached by their own menus and print their keys in their footer line; `g` there already means "top" in lists or an action on a screen, so a global `g` chord would collide.
