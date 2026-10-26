### 6b. The workspace — one screen for a whole repository

Opening a repository in the terminal opens a **workspace**, not a home page:
the explorer, a tab bar, the file you are reading, and the one commit that
carries everything you changed. There is no repo card to leave, no directory
screen to push, no blob screen under it and no editor screen on top. The four
screens that used to be there were four escapes deep and lost your place at
each one.

```
 forge                                                                          Ink
alice › alice/lighthouse
● workbench  ·  ○ this machine                                              main ▾
 README.md   src/lamp.ts ●   src/weather.ts                                 3 tabs
▾ src/            ┃  1 # Lighthouse
    lamp.ts     ● ┃  2
    weather.ts    ┃  3 A beacon. Rotates the lamp, logs the weather, warns the ships.
  package.json    ┃
▸ README.md       ┃
 main · 1 modified                                        src/lamp.ts · 22 lines
  tab focus explorer   e edit   c commit   b switch ref   t find file   i issues
```

The where strip keeps column zero, exactly as it does on every other
repository screen, and the ref pill (`main ▾`) takes the right-hand end of the
same row. At **≥100 columns** the explorer is a column beside the file; below
that it is the pane `tab` toggles onto, never both at once. A repository opens
on its **README** — the first file at the root if there is none — with the keys
already in the file pane, so `j` scrolls it without a keystroke of ceremony.

Four rules hold it together, and each one answers something the old
arrangement got wrong:

- **Moving the explorer's cursor reads nothing.** `j` moves a cursor over
  names; `enter` opens a tab. The preview-that-followed-the-cursor it replaces
  cost a read per keystroke, needed a debounce and a stale-read token to stay
  honest, and left you unable to scroll the file you were looking at because
  the selector lived in the other pane.
- **A tab owns its buffer.** Scroll position, in-file search, undo history and
  every unsaved edit live in the tab. Switching tabs keeps them; so does going
  to the issue list and coming back, because the workspace stays on the stack
  while something is pushed over it.
- **Editing is a mode, not a screen.** `e` turns the active tab into the
  buffer from `ui/editor.ts`, in place. `esc` goes back to reading **with the
  edits still there** — losing work takes `u` (discard this tab) or `x` (close
  it), and both ask first.
- **One commit for the whole change.** Every modified tab and every pending
  deletion goes into a single `editFiles` call.

| key          | in the explorer                  | in the file pane                |
| ------------ | -------------------------------- | ------------------------------- |
| `j` `k`      | move the cursor (reads nothing)  | scroll                          |
| `ctrl+d` `u` | page                             | page                            |
| `g` `G`      | top / bottom                     | top / bottom                    |
| `enter` `l`  | expand a directory / open a tab  | —                               |
| `h`          | collapse, or go to the parent    | scroll left (`l` scrolls right) |
| `tab`        | focus the file                   | focus the explorer              |
| `esc`        | back                             | focus the explorer              |
| `/`          | filter this level                | search in the file (`n` / `N`)  |
| `n` `D`      | new file / mark one for deletion | —                               |
| `e`          | open the file and edit it        | edit                            |
| `u`          | —                                | discard this tab's changes      |
| `v`          | —                                | the file's other view (below)   |

And the keys the whole workspace answers, from either pane: `]` `[` and `1`–`9`
move between tabs, `x` / `X` close one or the others, `c` commits, `b` lists
branches and tags, `B` creates a branch, `t` (or `ctrl+p`) is the fuzzy finder,
`y` copies the path, `i` / `p` / `C` open issues, pulls and commits, `I` shows
the about card, `W` swaps to the other side of a mirror, `O` opens the file on
its origin, `P` pins, `S` syncs, `F` forks, `,` is settings, `r` refreshes and
`E` hands the file to `$FORGE_EDITOR`.

**The tab bar.** One row above the panes: the path, the active tab bold and
underlined in the accent, `●` on anything modified, `¶` on prose being read
rather than edited, `‹ ›` when there are more tabs than fit, and the count on
the right. `¶` (U+00B6) is Latin-1, so it is in every font that can draw a box
character at all, and it is the one glyph in the safe set that already means
"formatted prose". A modified file wears the same `●` in the explorer, and one
marked for deletion is struck through in the danger colour — the same change,
said in both places. The **active** tab also wears a `✗` you can click; only
the active one, because a close box on every chip is a row of targets you hit
by accident, and the tab you mean to close is the one you are looking at.

**Two views, one key.** Some files have two honest ways of being seen, and `v`
is the toggle for all of them:

| file                | opens as             | `v` shows                |
| ------------------- | -------------------- | ------------------------ |
| `*.md`, `README*`   | rendered prose (`¶`) | the source, highlighted  |
| `*.png`, `*.jpg`, … | the picture (§6·0c)  | format · geometry · size |
| everything else     | code                 | (nothing else to show)   |

Prose opens **rendered**, because that is what a README is for and it is what
the repo card always did — but the rendered view is a view, not a mode: `j`/`k`
scroll it, `/` searches it, and `e` always edits the **source**, switching to
it if you were reading. The web and the terminal render that markdown through
the same rules, so a README reads the same in both.

**Colour follows the theme.** Switching theme re-tokenises every open tab on
the next frame; a tab that kept yesterday's palette is exactly the bug a
screenshot hides.

**Coming back is free.** A workspace's open tabs, its explorer cursor, its ref
and every uncommitted buffer live on the **session**, keyed by repository — so
popping to the dashboard and re-entering the same repo restores what you were
doing, not just where you were. One connection is one identity, so nothing
another user opened can be reached, and the memory dies with the connection;
an entry nobody has touched for thirty minutes is dropped on the next lookup.
`r` is still the refresh, and `x` still closes a tab.

**The about card (`I`).** What used to be the repo home page: visibility,
description, default branch, counts, where a mirror came from and when it was
last fetched, and the clone URLs (`y` copies one). It is a card rather than a
screen because it is something you glance at on the way to doing something
else.

The finder (`t`) scores with fzf's `--scheme=path` constants plus VS Code's
rule that any basename match outranks any directory-only match, and it says
"N files (truncated)" honestly when the listing hit its cap.
