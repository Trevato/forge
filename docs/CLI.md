# The `forge` command

`forge` is the client that lives on your machine: it keeps a copy of the repos
you work on under one root, reports how each one stands, and opens the local
terminal UI over them. Source: `src/cli/main.ts`. This page has one section
per command `forge help` prints; `test/cli-docs.test.ts` fails when a command
is added to `forge help` without a `## forge <command>` heading here.

Every example below is run with `NO_COLOR=1`. On a terminal, the same lines
are coloured and nothing else changes.

## Install

Build it once and put it on your PATH:

```sh
bun build --compile src/cli/main.ts --outfile dist/forge
```

That is a self-contained binary (it embeds the Bun runtime, 60–110 MB;
`dist/` is gitignored). Until you build it, `bun run src/cli/main.ts …` is the
same program.

Then sign in once with [`forge login`](#forge-login) and bring your repos
down with [`forge sync`](#forge-sync).

## Where things live

| What | Where | Override |
|---|---|---|
| The config (`config.json`, mode 0600) | `$XDG_CONFIG_HOME/forge`, else `~/.config/forge` | `FORGE_CONFIG_DIR` |
| The token | the macOS login keychain, else the config file | `FORGE_TOKEN`; `FORGE_KEYCHAIN=0` skips the keychain |
| The forge | the config file | `FORGE_URL` |
| Clones | `~/src/<host>/<owner>/<name>` | `--root DIR`, then `FORGE_ROOT` |
| Colour | on when stdout is a terminal | `NO_COLOR` or `FORGE_COLOR=0` turns it off |

`FORGE_URL` and `FORGE_TOKEN` together let a script or a CI job run any
command without a config file at all.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | done |
| 1 | failed (the forge refused, or a program could not be run) |
| 2 | usage: an unknown command or a missing argument |
| 3 | not signed in, or the stored token is unusable |
| 4 | partial: the run finished, but at least one repo did not |
| 5 | refused: the forge heard the request and said no (a rule, a conflict, a hold) |
| 6 | rate limited: the forge said "not now" and named when to try again |

A script can branch on these without parsing text.

## Flags every command takes

- `--help`, `-h` — print `forge help` and exit 0.
- `--version`, `-v` — print the version and exit 0.

```console
$ forge --version
forge 0.0.1
```

## forge

With no command, `forge` opens the local terminal UI: the library of clones
under the root, then a working-tree screen for one of them (`space` stages,
`enter` opens the hunks, `c` commits, `P` pushes, `?` shows every binding).
It works signed out; signed in, it also knows the forge. When stdout is not a
terminal it prints `forge help` instead and exits 2.

Flags: `--root DIR`.

```console
$ forge --root ~/src
```

## forge help

Prints the commands, the config path and the root, and exits 0.

```console
$ forge help
forge 0.0.1 — your workbench, on this machine

  forge                        the local terminal UI
  forge login <url>            [--token T] [--insecure]
  forge logout
  forge whoami
  forge sync                   [--watch] [--interval 5m] [--ff] [--root DIR]
  forge status                 [--root DIR] [--json]
  forge ls                     [--json]
  forge pin <owner/name>
  forge unpin <owner/name>
  forge open <owner/name>      [--web]
  forge pulls                  [--repo owner/name] [--closed] [--json]
  forge asks                   [--repo owner/name] [--json]
  forge ship <number>          [--repo owner/name] [--yes]

  config /home/you/.config/forge/config.json   root /home/you/src
  FORGE_URL, FORGE_TOKEN, FORGE_ROOT and NO_COLOR are honoured.
```

## forge login

Remembers a forge and a token. The URL may be bare (`forge.example.com` means
`https://`, `localhost:3000` means `http://`). The token is asked for without
echo, read from one line of stdin when stdin is a pipe, or given with
`--token`. It is checked against the forge before anything is stored: a token
the forge refuses is never saved (exit 3).

Plain `http://` to any host but this machine (`localhost`, `127.0.0.1`,
`[::1]`) is refused before the token is asked for, because every request
carries the token in clear (exit 2). `--insecure` lets it through for that one
forge and is remembered with it; every later command refuses the same way if
`FORGE_URL` points at a different plain-http host.

Flags: `--token T`, `--url URL` (the same as the positional), `--insecure`.

```console
$ echo "$TOKEN" | forge login forge.example.com
✓ signed in to https://forge.example.com as alice
  token in /home/you/.config/forge/config.json (0600)
```

On macOS the second line reads `token in your login keychain;
/home/you/.config/forge/config.json holds only the URL`.

## forge logout

Deletes the config and the keychain entry. It is not an error to run it
signed out.

```console
$ forge logout
signed out
```

## forge whoami

Asks the forge who the stored token belongs to.

```console
$ forge whoami
alice at https://forge.example.com
```

Signed out, it prints `forge: not signed in — run \`forge login <url>\`` and
exits 3.

## forge sync

Clones every pinned repo that is missing under the root, fetches the rest,
and prints one row per repo. It never merges, rebases, resets or checks
anything out. On a forge without pins it syncs the repos you own, and says so.

Flags:

- `--ff` — fast-forward a repo only when its tree is clean, nothing is ahead,
  no rebase or merge is half-finished, and `merge-base --is-ancestor` proves
  the move loses no commit.
- `--watch` — keep running; after the first report, print and send a desktop
  notification only when something changed.
- `--interval 5m` — how often `--watch` syncs: `90s`, `5m`, `2h`, `500ms` or a
  bare number of seconds. Default `5m`.
- `--root DIR` — the library to sync into.
- `--json` — one JSON object per report instead of the table (the same fields
  as [`forge status --json`](#forge-status)).

Exits 4 when any repo failed.

```console
$ forge sync
REPO         BRANCH  SYNC  DIRTY  STATE       FETCHED
alice/notes  main                 cloned          now
alice/site   main      ↓2      1                  now
alice/docs   —                    not cloned

○ alice/docs: not cloned yet — run `forge sync`
```

`↑n` is commits ahead of the upstream, `↓n` behind; `DIRTY` counts staged,
changed, untracked and conflicted files; a repo with nothing to say gets `✓`.

The token goes to git only when the repo's `origin` is this workbench's own
origin over https (or plain http to loopback). Any other `origin` — an edited
remote, say — is fetched without it, and the row's state reads `no token sent`.

## forge status

The same report as `forge sync` without touching the network: nothing is
cloned or fetched, so it answers when the forge does not.

Flags: `--root DIR`, `--json`.

```console
$ forge status --json
{"root":"/home/you/src","pinsUnavailable":false,"failures":0,"repos":[{"owner":"alice","name":"notes","path":"/home/you/src/forge.example.com/alice/notes","present":true,"cloned":false,"pinned":true,"branch":"main","upstream":"origin/main","ahead":0,"behind":0,"staged":0,"changed":0,"untracked":0,"conflicted":0,"dirty":0,"stashes":0,"unpushed":[],"fastForwarded":false,"lastFetch":"2026-10-27T09:12:00.000Z","error":null}]}
```

## forge ls

What is on disk and how stale, read from disk alone.

Flags: `--json` (the same object as `forge status --json`), `--root DIR`.

```console
$ forge ls
/home/you/src
REPO         BRANCH  SYNC  STATE       FETCHED
alice/notes  main          ✓                2h
alice/site   main      ↑1  1 dirty          2h
alice/docs   —             not cloned
```

## forge pin

Asks the forge to keep a repo on your machines; the next `forge sync` clones
it. Takes `owner/name` and nothing else (exit 2 otherwise).

```console
$ forge pin alice/docs
✓ pinned alice/docs
  run `forge sync` to bring it down
```

A forge without pins answers `forge pin: this forge does not support pins
yet` (exit 1).

## forge unpin

Stops keeping a repo. Nothing on disk is deleted; `forge sync` simply stops
fetching it.

```console
$ forge unpin alice/docs
✓ unpinned alice/docs
```

## forge open

Prints a repo's web address; with `--web` it also opens it in your browser
(`open` on macOS, `xdg-open` elsewhere).

Flags: `--web`.

```console
$ forge open alice/notes
https://forge.example.com/alice/notes
```

## forge pulls

A repository's pulls, one line each: the number, the title cut to fit the
terminal, the author, the check (`green`, `red`, `running` or `none`) and the
preview address when there is one. The repository is `--repo`, or else the
current folder's `origin` when it is a clone of this workbench (exit 2
otherwise). With none, it prints `No open pulls.`

Flags:

- `--repo owner/name` — the repository (exit 2 if it is not `owner/name`).
- `--closed` — closed pulls instead of open ones.
- `--json` — the forge's answer as it came.

```console
$ forge pulls --repo alice/shop
#3  Checkout totals in cents  bob    green  https://shop--3.example.com
#2  Dark print view           carol  red
```

## forge runs

What the crew is doing on a repository: its last 10 runs, newest first, one
line each: the state (`queued`, `running`, `ok`, `failed`, `cancelled`), the
agent, the pull or issue number, the title, the age (of the finish, else the
start) and the cost when there is one. The agent, number and title are the
runs API's own `agent`, `number` and `title` fields: a check or deploy has no
agent, and a run about no pull or issue has no number or title, so those
columns are blank rather than guessed from the branch. The repository is `--repo`, or else the current folder's `origin` (exit
2 otherwise). Not logged in exits 3; any other refusal prints the forge's words
and exits 1. With none, it prints `No runs yet.`

Flags:

- `--repo owner/name` — the repository (exit 2 if it is not `owner/name`).
- `--json` — the forge's answer as it came.

```console
$ forge runs --repo alice/shop
running  scout  #6038  Login fix                   now  $0.50
failed          #7696  Tidy the header              2h
```

## forge asks

What waits on you, one line each, most important first: the kind, the
repository, the title cut to fit the terminal, and the address where you
decide it. The forge's own needs have no repository. With none, it prints
`Nothing waits on you.`

Flags:

- `--repo owner/name` — only that repository's asks (exit 2 if it is not
  `owner/name`).
- `--json` — the forge's `/api/v1/asks` answer as it came, narrowed by
  `--repo` when given.

```console
$ forge asks
look    alice/shop   Pull #3 is green — look and merge  https://forge.example.com/alice/shop/pulls/3
parked  alice/notes  Issue #9 waits on a decision  https://forge.example.com/alice/notes/issues/9
```

## forge tell

Tell the crew something about a repository; it becomes an issue. The
repository is that of this folder's `origin` when it points at the workbench,
or `--repo`. Words are 1 to 2000 characters; start them with a dash after `--`.

Flags:

- `--repo owner/name` — the repository, instead of this folder's origin.
- `--variants 1-4` — how many attempts the crew makes.
- `--from /path` — the workbench page you were looking at.

```console
$ forge tell "make the header smaller"
told alice/shop: issue #12  https://forge.example.com/alice/shop/issues/12
```

## forge talk

Say something to the forge's own agent, as you, and print what it answers.
The agent works through the forge's MCP with your permissions; a write it
would make is held for your yes (Confirm or Cancel on `/talk`). Words are 1 to
20000 characters. It waits up to two minutes, then says where to read the rest.

```console
$ forge talk "what is waiting on me?"
```

## forge new

Makes an app from the shell, as `POST /api/v1/apps` does, then clones its
repository into the same folder `forge sync` fills (cloned from the address
the forge answers with) and prints the app's page and, when it has one, its
live address. A refusal (name taken, invalid name, repository, storage or app
limit) prints the forge's own words and exits 5, and nothing is cloned. No
name is exit 2.

Flags:

- `--private` — only you can see it (public otherwise).
- `--owner org` — make it under an organization you belong to.
- `--root DIR` — the library folder to clone into.

```console
$ forge new notes a notes app for the team
✓ made alice/notes
https://forge.example.com/alice/notes
https://notes--alice.example.com
  cloned to /home/alice/src/forge.example.com/alice/notes
```

## forge map

The plan of the repository: three groups that do not overlap, each headed
with its count. **Working** is what the crew is on (`#N title — assignee`),
**Ready** is the map's `startable` issues: nothing open stands in front of
them and nobody has started or held them, so the count matches the map
page's (`#N title — pillar`), and **Waiting** is every open issue with an open
blocker (`#N title — waits on #A, #B`). Titles are cut to the terminal and a
group stops at 15 lines with `… N more`; an empty one says so (`nothing
ready`). The repository comes from `--repo`
or from the folder's `origin` remote on the configured workbench.

Flags:

- `--repo owner/name` — the repository to read (exit 2 if it is not
  `owner/name`, or if it is missing and the folder is not a clone).
- `--json` — the forge's `/api/v1/repos/:owner/:name/map` answer as it came.

```console
$ forge map --repo alice/shop
Working (1)
  #12 Checkout keeps the cart — torque

Ready (1)
  #14 Receipts by mail — Payments

Waiting (1)
  #15 Refunds — waits on #14
```

The same plan is open to agents through MCP, as the `map` tool, and to
people in the terminal UI (`m` on a repository's issues list):

```json
{ "name": "map", "arguments": { "app": "alice/shop" } }
```

## forge search

Code, issues, pulls and repositories the token can read, from
`/api/v1/search`. Each kind is headed by its name and count, then one hit a
line: `owner/name:path:line  text` for code, `owner/name#N  title  state`
for issues and pulls, `owner/name  description` for repositories. With no
hit it prints `Nothing found for "…".` A 429 prints the forge's words with
the retry time and exits 6; a 401 exits 3.

Flags:

- `--kind code|issues|pulls|repos|all` — one kind (exit 2 for anything
  else). `issues` and `pulls` ask the API for its whole window and cut to
  `--limit` after keeping the one kind.
- `--limit N` — at most N hits per kind, a whole number above 0.
- `--json` — the forge's answer as it came; for `--kind issues|pulls`,
  narrowed, with `truncated.issues` set when more matched.

```console
$ forge search retry budget
code (1)
alice/shop:src/retry.ts:14  const budget = retry(attempts);

issues (1)
alice/shop#7  Retry budget runs out  open
```

## forge ship

Lands a pull, as its Merge button does: prints the pull with its check and
whether it merges, asks `Ship #N? [y/N]`, then merges. Anything but `y`
prints `not shipped` and exits 0. The forge's merge rules stay the forge's;
a refusal prints its own words and exits 5 (exit 3 when the token is
refused). The repository is `--repo`, or else the current folder's `origin`.

Flags:

- `--repo owner/name` — the repository.
- `--yes` — ship without asking. Without a terminal to ask on, `--yes` is
  required (exit 2).

```console
$ forge ship 3
alice/shop#3  Checkout totals in cents
  check green · mergeable
Ship #3? [y/N] y
✓ shipped #3 as 9f2c1ab
https://forge.example.com/alice/shop/pulls/3
```

## forge ui

The local terminal UI, the same as [`forge`](#forge) with no command.

Flags: `--root DIR`.

```console
$ forge ui
```

## forge talk

Say something to the forge's own agent, as you, and print what it answers.
The agent works through the forge's MCP with your permissions; a write it
would make is held for your yes. The words are 1 to 20,000 characters
(exit 2 when empty or too long); a 401 exits 3. It waits up to two minutes
for the answer, then says to read it on the feed.

Flags: none.

```console
$ forge talk "what is waiting on me?"
Two pulls are green and wait for your merge: #12 and #15.
```

## forge data

The SQLite files you may read, from a shell (so nvim and other editors can use
them). The forge decides what you see (an admin: its own `forge.db`; a writer
of an app: that app's databases per environment) and masks secrets, exactly as
the Data screen and the MCP `data` tool do.

- `forge data` lists the databases.
- `forge data <app> [env]` lists that app's tables (`env` defaults to production).
- `forge data <app> [env] --table name [--page n]` prints 50 rows.
- `forge data <app> [env] "SELECT …"` runs one read-only SELECT (5 s, 1,000 rows); a write is refused with the forge's words and exit 1. SQL is 20 runs a minute per person, shared with the web and terminal; past that it prints "try again in N s" and exits 1.

`--file x.db` picks among several databases of one environment (`app.db` is the default). `--json` prints an array of objects (rows) or of tables. An unknown or unreadable app exits 2; not logged in exits 3.

```console
$ forge data notes "select name from users" --json
[{"name":"ann"}]
```
