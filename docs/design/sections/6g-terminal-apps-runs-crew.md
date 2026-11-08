### 6g. Apps, runs and the crew, where the terminal still shows them

The terminal's half of §5c is deliberately small: running an app and
managing the crew are the studio's (`docs/STUDIO.md`), and the terminal has
no apps, app, runs, run or crew screen and no palette entry for one. What
remains is where the work is reviewed:

- **Pull** — a preview line when the repository is an app (`O` opens it,
  `P` opens production beside it: comparing the two is the review), a
  checks row in the merge box and a _waiting on checks_ state with the refusal
  in words on `m`, `a` to assign (nobody, people, then the crew with the bot
  glyph on a Nerd Font), and a Crew tab of the agent runs about it.
- **`T` on a pull's preview** suspends the UI and runs the app's `tty` on
  the same pty — one connection, two programs in turn, exactly as
  `$FORGE_EDITOR` runs — and the UI returns when it exits. Every refusal
  (not running, no `tty`, private to a guest) is a toast in the same words
  the ssh front door uses.
- **Issue** — `a` to assign; a Crew card when an agent has runs, `tab` moves
  focus to it.
- **A run** is a row (`screens/runlist.ts`): state dot and word, who, why,
  the summary. `enter` on one hands over its web page,
  `/:owner/:name/runs/:id`, where the live log, cancel and steer are — as a
  link when the forge knows its public URL, as the path otherwise.
- **Steer** a running agent run from the terminal: `S` on the runs list, `s`
  on an issue's Crew card and on a pull's Crew tab. Offered to a writer who
  is a person, never an agent, on a running agent run only; it sends through
  the same action as the run page's steer box and MCP `steer`, and the toast
  says whether the agent heard it or it became a comment.
- **Settings** — the App tab (enable with slug, access and preview data; edit;
  `D` to stop running as an app behind a confirm), `C` for require checks on
  General, the Crew tab (`a` adds an agent from the forge's, `d` removes).

A guest is told so in words; nothing here is a way around the actions'
answers.
