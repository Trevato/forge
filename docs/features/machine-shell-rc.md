# A machine shell's first screen

The shell opens in the person's own checkout of the repository (cloned once from the bare repo, kept between sessions), with bun and git on the path. It prints a greeting: which repository and machine, how to leave (detach with Ctrl-b d to keep it running, `exit` to end it) and the app's own `tty` command when forge.json has one. The prompt shows `owner/name:branch`. History is `.forge_history` in the person's home under `FORGE_APP_DATA/machines/<repo>/<machine>/<person>/home`, written after every command.

The rc file is the constant `RC` in `src/machines/rc.ts`; nothing from a request reaches it.

The checkout is cloned when the shell is first opened, off the event loop. Two connections at once share one clone. git gets 30 seconds (`CLONE_MS`), then it is killed; at most four first clones (`MAX_CLONES`) run across the forge at once. A clone that fails, runs out of time or finds no room leaves nothing behind (it is made in `checkout.partial` and renamed only when complete), the next connection tries again, and the greeting says the shell starts in home instead. Detach is only mentioned when tmux holds the session.

Without bash on the machine, `/bin/sh` still prints the greeting, starts in the checkout and shows the repository in the prompt; it has no branch in the prompt and no persistent history, because sh has neither.
