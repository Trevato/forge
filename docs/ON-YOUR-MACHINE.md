# On your machine

The forge holds the truth; `forge` keeps a copy of the parts you work on, the
way a music player keeps the albums you listen to — downloaded, fresh, and
yours when the network is not.

```sh
forge login forge.example.com    # a URL and a token, stored 0600 (macOS: keychain)
forge sync                       # clone what is missing, fetch the rest, report
forge status                     # the same report, without touching the network
forge                            # the local UI over your clones
```

A bare host means https; `localhost`, `127.0.0.1` and `[::1]` mean http. Plain
`http://` to any other machine is refused — the token would cross the network in
clear — unless you log in with `--insecure` for a host you trust; that is kept
with that workbench only, and `FORGE_URL` to another such address is refused too.

Repos land under `~/src/<host>/<owner>/<name>` — the path is the identity, so
two forges with a `docs` repo never collide, and the filesystem is the index
(there is no local database of "your repos"; the walk finds them). `--root`
or `FORGE_ROOT` moves the library; `FORGE_URL` and `FORGE_TOKEN` override the
stored config for a script or a CI job.

```sh
forge sync --watch --interval 5m   # notify only when something CHANGED
forge sync --ff                    # fast-forward clean repos, and only those
forge pin owner/name               # ask the workbench to keep this one here
forge ls                           # what is here, and how stale
forge open owner/name --web        # the page, in a browser
forge ship 12                      # land pull #12 after a y/N, as Merge does
forge pulls                        # open pulls of this clone, newest first
forge runs                         # the crew's last 10 runs here: state, agent, #N, title, age, cost
forge asks                         # what waits on you, most important first
forge asks --repo owner/name       # only that repository's; --json for the API's answer
forge asks --ship 1 3              # decide by the line numbers just printed: planned, then Apply? [y/N]
forge asks --close 2 --reason "words"   # also --dismiss 4; --yes skips the question (needed without a TTY)
forge asks --undo <id>             # take back a decision by the receipt id it printed
forge tell "make the header smaller"   # tell the crew, about this folder's repo (--repo owner/name overrides)
forge map                          # the plan of this clone: working, ready, waiting
forge search retry budget          # code, issues, pulls and repos you can read; exits 6 on "not now"
forge search x --kind pulls --limit 5   # one kind, five hits; --json marks truncated.issues when more matched
```

`forge tell` makes an issue of your words (1 to 2000 characters) and prints its
address. `--variants 1-4` asks for that many attempts and `--from /path` names
the workbench page you were looking at, as the API takes them. Words that start
with a dash go after `--`: `forge tell -- "--fast"`.

The MCP `tell` tool takes `from` but not `variants`. The terminal (tty) takes
neither.

`forge ship <number>` reads the repository from `--repo owner/name` or from
the folder's `origin` when it points at your workbench, shows the pull's
title, check and whether it merges, and asks `Ship #12? [y/N]`. `--yes` skips
the question; with no terminal and no `--yes` it refuses (exit 2). The
merge's rules stay the forge's: a refusal prints the forge's words and exits
5 (3 for a refused token), and is never retried.

`forge pulls` prints one line per pull: `#N`, the title cut to the terminal
width, the author, the check (`green`, `red`, `running` or `none`) and the
preview address when the repository is an app. It asks about the repository
your `origin` remote names, when that remote is on the configured workbench;
anywhere else it exits 2 and says so, and `--repo owner/name` names one
yourself. `--closed` lists closed pulls, `--json` prints the API's answer, and
a list longer than the 100-pull pages it follows is marked as cut. This is a
shell command on purpose: the terminal UI of the forge (`ssh`, `src/tty.ts`)
already has its own pulls screen, and the local UI is about working trees, not
the workbench's conversation; the pulls API and MCP are the other doors.

`forge map` reads the plan of the same repository (`--repo` or `origin`, as
for `pulls`) from `GET /api/v1/repos/:owner/:name/map` and prints three
groups, each headed with its count: Working (`#N title — assignee`), Ready —
the map's `startable` subset of its ready issues, unassigned and not held, so
its count matches the map page's ready count (`#N title — pillar`) — and
Waiting (`#N title — waits on #A, #B`, open blockers only). Titles are cut to
the terminal, and a group past 15 lines ends `… N more`. `--json` prints the
API's answer unchanged; an unknown repository prints the forge's words and
exits 1 (3 for a refused token, 5 for a forbidden one).
The same plan is a screen in the forge's terminal UI: press `m` on a
repository's issues list (`src/tui/screens/plan.ts`).

`sync` never merges, rebases, resets or checks anything out. `--ff` is the one
exception and it fast-forwards a repo only when the tree is clean, nothing is
ahead, no rebase or merge is half-finished, and `merge-base --is-ancestor` has
proved that moving the branch cannot lose a commit. A dirty repo is reported
and left exactly as you left it.

`sync` hands git your token only for a remote on the workbench's own origin
(scheme, host and port) over https, or plain http to loopback. A clone whose
`origin` was edited to anywhere else is fetched without the token, and its row
says `no token sent`.

`forge` with no arguments opens the local UI on the same runtime as the SSH
one: the library of clones, then a lazygit-shaped working-tree screen —
`space` stages, `enter` opens the hunks, `s` stages one, `c` commits, `P`
pushes, `b` branches, `l` log, `z` stashes, `?` shows every binding.

`forge runs` lists the last 10 runs of the same repository (`--repo
owner/name` names another, `--json` prints the API's answer). Each row of
`GET /api/v1/repos/:owner/:name/runs` carries `agent` (the agent run's
username, null for a check or deploy), `number` and `title` (its pull or
issue, null for none), so no client reads them out of a branch name. The SSH
terminal's door is `H` on a repository: the runs screen
(`src/tui/screens/runs.ts`), read through the same `listRepoRuns`, so a guest
sees only what the page shows them and a stranger sees no cost or session.

In the SSH terminal, `enter` on a run opens its log (the last 200 lines, following new ones while it runs; "Not found" where the web would say so), and `o` there prints the web address (`src/tui/screens/runlog.ts`).

Build it once and put it on your PATH:

```sh
bun build --compile src/cli/main.ts --outfile dist/forge
```

That produces a self-contained binary (it embeds the Bun runtime, so expect
something in the 60–110 MB range; `dist/` is gitignored and binaries are never
committed). Until you build it, `bun run src/cli/main.ts …` is the same
program.
