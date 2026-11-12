# A `Dockerfile` opens as its stages

A file named `Dockerfile`, `Containerfile` or `*.Dockerfile` (any case) opens as one block per stage instead of raw text. Source is one tap away (`?view=source`).

- **Stage head:** each `FROM` starts a block titled with its image and `AS` name. `EXPOSE` ports and `ENV` names (never their values, which may be secrets) show under the title.
- **Rows:** every other instruction is one row, keyword and arguments, with `\` continuation lines joined and comment lines dropped. `ARG`s before the first `FROM` sit in a block of their own.
- **Fallback:** a file with an unknown instruction or no `FROM` shows Source with the reason. Heredoc bodies (`RUN <<EOF`) are skipped to their terminator, so the instruction shows and its body lines do not.
- **Cap:** at most 500 instructions, then `N more instructions not shown`. Files over 1 MB keep Source. Arguments are cut at 400 characters.
- **Terminal:** the workspace screen opens a Dockerfile as a table (stage, instruction, arguments: the ports and ENV names first, then one row per instruction), with the same fallback reason; `s` shows the source.
- Every value is escaped, drawn on the server; no script, no new CSS, no dependency.

Code: `src/web/render/dockerfile.ts`, `src/web/render/kinds.ts`, `src/tui/screens/workspace.ts`. Test: `test/render-dockerfile.test.ts`, `test/tui-workspace.test.ts`.
