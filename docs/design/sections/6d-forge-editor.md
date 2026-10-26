### 6d. `$FORGE_EDITOR` — the operator's own editor, over a pty

`E` suspends the UI and hands the terminal to `$FORGE_EDITOR` on a real pty.
**Read this before enabling it:** the editor runs on the forge host as the
forge user, and nvim's `:!sh`, `:terminal` and a sourced `init.lua` are all
arbitrary code execution. CVE-2019-12735 was RCE in Neovim from merely opening
a file with a hostile modeline, which is the exact shape of a host whose job is
displaying files other people wrote.

It is coherent under one framing only: **this is the operator's own single-user
workbench, and the editor is their shell reached through the forge.** So it is
opt-in and absent otherwise — with `FORGE_EDITOR` unset there is no spawn, no
temp file and one line of explanation; the name is resolved once with
`Bun.which` and spawned as `[bin, file]` **argv, never a shell** (a name with
whitespace in it is refused rather than tokenized); and one handoff at a time
per session, because nested suspends are the wedge behind every "my TUI hung
after I shelled out" report. Nothing in that path writes to a repository: what
comes back is spliced into the tab's own buffer — one undoable edit, and a
modified tab like any other — and reaches git only through `c` and `editFiles`,
the one way anything does. `E` is the escape hatch rather than the tool, so it
sits last in the binding list and falls off the end of the help bar.

Resume is unconditional and state-independent — the child may have crashed, so
"undo what we think it did" is exactly the reasoning that leaves a broken
terminal. Two fixes beyond re-entering the alt screen, both measured against
real nvim: `ESC[0 q` because it exits leaving a steady block and never resets
the cursor shape, and `ESC[>0u` to pop kitty keyboard flags it pushes and does
not. The input decoder is rebuilt on resume so the Primary DA reply that
arrives _after_ the child is gone lands nowhere.

**Gap:** a launch should leave an outbox event (invariant 5), and appending one
from an adapter would break the rule that only `actions/` does. It is a log
line for now; the action belongs beside `actions/contents.ts`.
