# What works today

This document lists the features that work in today's forge. It is for
operators and contributors who need a concrete inventory of shipped
capability. Each bullet names one feature and the doors that reach it.
Claims match the code on the default branch; cut or fix anything you
cannot confirm. A package registry is not shipped yet.

## Features

- **A long file's page** draws its first 1,500 lines and says "N more
  lines", with *Show all lines* (`?all=1`) and the raw file. `?all=1` stops at
  10,000 lines (it was 5,000 for every view before); past that, the raw file is
  the way. Highlighted lines are cached by content hash (32 files, least
  recently used out). A `#L…` anchor past the cut is redirected to `?all=1` by
  the page script; with scripts off the notice says to show all lines.
- **A repository's runs page filters by state**: a row of links (All, then each
  state) above the list, or `/:owner/:name/runs?state=failed` by hand. An unknown
  state is ignored, and the word filter and the pager keep the chosen state. The
  terminal does the same: `H` in a repository opens its runs, and `s` cycles
  All, Failed, Running, Succeeded.
- **A run page's live log** rides the page's one `/events` connection (its
  `run.log` frames); it opens no stream of its own. Known gaps, both silent: a
  frame the server cuts for size (64 lines or 16 KB) loses its omitted lines
  until the next reconnect's catch-up read, and a run whose log was already cut
  to its last 512 KB at render gets no catch-up read. The page says
  "Reconnecting" while the connection is down.

- **Cut a wave**: Settings → *Cut a wave* (repository admins, same-origin
  POST) opens a pull
  adding `waves/<next>.md`, listing the pulls merged since the last wave and
  not already in an earlier wave. The headline and highlights are `TODO`
  placeholders; no model is called. It refuses, writing nothing, when an
  earlier wave does not parse (naming the file) or nothing new has merged.
  The terminal's waves screen does the same with `c`: it says how many pulls
  would go in, asks `cut wave N? y/n`, and on `y` shows the draft pull's
  number (Enter opens it), through the same action and refusals.
  `/:owner/:name/waves` lists the waves on the default branch, newest version
  first, each line opening `/:owner/:name/waves/<version>` (headline, date,
  highlights with why, pulls as links; linked from that settings card); in the
  terminal, `V` in a repository opens the same list and Enter (or a click) on
  a row opens the same wave as plain text (a live browse of another forge says
  waves are only read on this forge).
  `/:owner/:name/waves.atom` is the same list as an Atom feed (newest 50, each
  entry the headline, its highlights and a link to the wave), advertised from
  the waves page; a private repository's feed is a 404 to anyone who cannot
  read it.

- **Accounts & access**: register/sign in, personal access tokens with coarse
  scopes (ro/rw/admin), public and private repositories.
- **Git**: push and pull over HTTPS **and SSH**, browse code (tree, blob with line anchors,
  commit history) with README rendering and **syntax highlighting**, protected
  default branches (force-push and deletion refused, honest fast-forwards
  allowed).
- **System memory**: `/system`, for a forge admin who is a person (anyone else gets 403): the forge's RSS beside its JS heap (`heapStats()` from bun:jsc), hourly mean and max for the last 24 h, drawn on the server. Sampled once a minute into `memory_hour` in `app.db` (a week kept). RSS rising while the heap stays flat is native memory growth.  In the terminal the same admin has a **System memory** command in the palette: the last 24 hours as text rows (hour, RSS mean/max, heap mean/max in MiB), read-only. The account menu links `/system` for that admin.
- **Flow alarms**: a firing alarm (red main, a stuck approved pull, an idle crew, no release for 90 min) shows as one linked line above home's feed and on `/boards` (admin), under the vitals line of the terminal's Flow dialog and home, as one phone notification when it starts (not repeated while it stands), and in the `flow` tool's `alarms` (MCP, `/api/v1/telemetry/flow`; an agent's cut to public repositories). Nothing firing draws nothing. The dialog also lists the idle crew pulls (number, repository, hours since the last push), oldest first, at most 20 read and five drawn with `+N more`; none draws nothing, and an agent's list is cut to public repositories.
- **Clog watch**: the minute tick (`src/flow/clog_tick.ts`) reads the flow; when a clog starts the admin gets one phone notification, and when it clears one `clog.cleared` note (cause, time to clear, peak stranded $) lands once on the admin's feed and as a line on the terminal's home. The watch state is in the database, so a restart repeats neither.
- **Boards**: `/boards` also shows the pipeline (a row per stage, the bottleneck named) and the held counts (why each autonomous repository's ready issues wait; private repositories included), for the same admin who is a person; they sit as two cards under the board list, not as panels of a board, because they are not saved queries. The terminal's Boards screen does not draw them: its door to the same rows is the **Flow** dialog. `/boards/data`, for a forge admin who is a person (anyone else
  gets a 404 on the page): the query is the URL (`?source=runs&aggregate=count&by=day&fcolumn=state&fvalue=failed`),
  drawn server-side as the chart chosen beside it (`chart=line|bar|area|number|table|heat`)
  with its points in a table; a point opens the rows behind it, keeping your filter.
  `series=<column>` splits each group by a second column: stacked area draws one band per
  value (eight at most, the rest folded into "other"), the heat strip one row per value
  (twelve at most) with time across, the table a series column; line, bar and number set
  it aside. Number is the latest group's value over a sparkline of all of them.
  `/boards` holds the boards themselves: a board is one JSON file
  (`{title, range, refresh: off|10s|1m, panels: [{title, chart, query, w, h}]}`) in
  `forge/boards`, a repo the forge owns and makes on the first boot with an admin; every save is a commit
  by the admin who made it, and a file that does not validate is not shown. Make, rename,
  duplicate, delete, add/edit/remove/reorder panels, or pin the query on `/boards/data`.
  The terminal's Boards screen shapes the list too, through the same actions: `n` asks for a title, makes the board and opens it, `c` copies the marked row, `D` asks `delete <title>? y/n` (`y` deletes; `n` or `esc` cancels). `e` renames the marked board and `g` sets its range, each in a prompt prefilled with the current value, through `changeBoard` as the page's Rename and Settings do: a range change keeps the board's refresh, a refusal is shown in the page's words and the board stays as it was, and both keys are offered only to a forge admin who is a person (for anyone else `g` keeps the list's jump to the first row; for an admin `home` does that, since `g` sets the range). On a board's screen `x` asks `remove <panel title>? y/n` for the marked panel: `y` reads the board again and removes it through `changeBoard`, as the page's Remove does, unless another door moved or removed panels meanwhile (then nothing is removed and the screen shows the board as it is), `n` or `esc` cancels, and the key is offered only to a forge admin who is a person; a pin on the removed panel is left as the page leaves it. A refusal is shown in the page's words (`boardRefusal`) and nothing changes.
  Any panel has **Pin to home** / **Unpin** on its board page (a same-origin POST); pins are per admin, kept in `board_pin` (slug + panel title + position, `boards/pins.ts`), and home draws them under the KPI row in that person's order with Up, Down and Unpin beside each (`web/studio/pinned.ts`). A pin whose panel is gone is skipped, does not count toward the limit of 24, and is dropped at that person's next pin; nobody sees another's pins. All doors go through `actions/board-pins.ts` (an admin who is a person; anyone else gets not-found):
  - the page (Pin to home / Unpin on `/boards/:slug`, Up / Down / Unpin on home);
  - the terminal: on a board's screen `[` `]` mark a panel, `p` pins or unpins it, `<` `>` move a pinned one; the dashboard lists the pinned panels by title;
  - `GET /api/v1/boards/pins` (the list, in order) and `POST /api/v1/boards/pins` with `{"op":"pin|unpin|move","slug":"…","title":"…","by":-1|1}` (`by` for move only);
  - the `board_pins` MCP tool (no `op` lists; `op` pin, unpin or move changes). `pins` is therefore not a board slug.
  The first boot also writes the starting boards, **Usage**, **Serving**, **Crew**, **Releases**, **Apps**, **Security**, **Throughput**, **Reach** and **Forges**; Serving is the forge's event-loop lag p99 beside the checks and crew runs running, so checks' concurrency is raised on numbers. Apps' per-app panels show repo ids until a source exposes a safe name; Security (sign-ins, failed sign-ins, tokens by scope, admin actions, from the admin-only `signins`, `tokens` and `adminActions` sources and `usage`) shows no token text, hash, payload or IP; Throughput is items entering each stage from issue to live, per hour, from the `stages` source. Each is written once: `.offered` in that repo records them, so an edit stays and a deletion sticks.
  A live board (any `refresh` but `off`; the form offers off or on, and `10s` and `1m` are still accepted and mean the same) redraws its grid when a run, pull, check, issue or usage event arrives, through the live-region swap
  (`/boards/:slug/live`, etag'd, one fetch per burst). The same doors are in the API: `GET /api/v1/boards`, `GET|PUT|DELETE /api/v1/boards/:slug`, and each panel's data as JSON or CSV at `GET /api/v1/boards/:slug/panels/:id?from=&to=&step=5m&format=csv`, bucketed in SQL to the step and never cut short (`docs/APPS.md`); each panel's card links `json` and `csv` (a plain download link) beside `explore`
  (an agent or anyone but an admin is 403; a panel whose query cannot run is refused with 422). The same four doors are MCP tools (`boards`, `board_write`, `board_delete`; `boards` with a `slug` reads one, and with a `panel` too that panel's data, with the same `from`, `to` and `step`) and, for the same person, a **Boards** screen in the terminal that lists boards and shows a board's panels as text, each with what its data holds now (a time panel's last bucket and step, another's row count). No dependency was added.
- **Parked work**: the terminal's Flow dialog says how many issues the crew parked (an open issue whose newest comment is the crew's `Parked by the crew` note) in the last 24 h and 7 d, and names the newest three; the MCP `flow` tool returns the same as `parked`. The flow panel on `/boards` draws two lines under its numbers, each left out at 0: `N idle pulls` (open crew pulls whose head has not moved for 72 h; the oldest three linked, `and K more` after) and `N parked today, M this week` (linking the newest parked issue). The Flow dialog lists them too (`idle: N`, a row each, `+K more`). `/boards` is the owner's; the MCP `flow` tool, as an agent, reads public repositories only (sealed issues left out). `and K more` opens `/boards?idle=all`, a list of every idle pull. See `docs/TOUR.md`.
- **Issues**: labels, threaded comments, close/reopen, markdown.
- **Pull requests**: open from a branch, a **diff viewer** (syntax
  highlighting composed with intra-line word highlighting, mobile-first,
  collapsible files), merge-commit and squash strategies, conflict detection,
  and merge commits kept reachable forever via `refs/pull/N/merged`.
- **Review comments**: anchored to a diff line by content hash, so a
  force-push re-anchors them or marks them outdated, never misplaces them.
- **Forks**: alternates-backed (instant, storage-bounded), with cross-repo
  pull requests (fork → upstream) and detach-before-delete safety.
- **Organizations & teams**: orgs own repos; teams grant read/write/admin
  resolved through membership.
- **Live updates**: a server-sent-event stream turns comment threads live and
  flags new activity, no refresh.
- **Commit pages**: every commit's diff through the same viewer.
- **Settings**: visibility, branch protection, and labels.
- **The check lane is visible.** Checks run one at a time; an admin's home
  strip, the terminal dashboard's strip and `GET /api/v1/health` (`lane`) show
  the queue depth, the running check and its age, the median of the last
  twenty and the time to clear, and the 30-minute queue card names that cause.
- **A terminal UI**: `ssh` in for the whole forge: dashboard, code browsing
  with syntax highlighting, issues and pulls with live-updating threads, the
  diff viewer with inline review comments, merges, settings, orgs, tokens and
  keys. Six themes, remembered per account.
- **Origins**: connect GitHub, Forgejo or Gitea (device code, PKCE, or a
  pasted token), mirror repositories in with their issues and pulls, and write
  through to the origin on every comment, state change, label and push. Pins
  say what the local client keeps cloned.
- **Automation**: a JSON API covering repos, issues, forks, and orgs (the
  label-as-queue surface), a durable event outbox, and **webhooks** (HMAC-signed
  delivery with retry). Every send goes through `src/kernel/outbound.ts`:
  - https URLs only; the host is resolved, private addresses are refused, and no redirect is followed.
  - A refused delivery fails at once, with the reason shown on the hooks page.
  - An unreachable or erroring endpoint is retried with growing delay.
- **Where an account came from**: `GET /api/v1/admin/accounts` lists each
  account with `via` (`signup`, `edge`, or null) and `signsInThrough`
  (`"open-platform.sh"` for an account the platform edge made, else null);
  Settings → Accounts and the new-account line in the inbox say "signs in
  through open-platform.sh" for the same accounts. The terminal and the MCP
  have no accounts list to carry it.
- **Removing an account**: `DELETE /api/v1/admin/accounts/:username` (admin
  only). An account that is the last owner of an organization answers 409 with
  the organizations named. Send `{"retireOrgs": true}` to preview: the answer
  lists each organization, its repositories (and the app each runs) and its
  teams, and changes nothing; the account's own repositories and the app each
  runs are listed too, under `own`. Send `{"retireOrgs": true, "confirm": true}` to
  do it: apps are stopped, repositories deleted, organizations retired (the
  name stays taken), then the account. If a repository will not go, the answer
  is 500 with `failed` and `removed`; what is left is intact and the same call
  again finishes the job. The accounts page offers the same flow: Remove →
  "Remove the organization too" → a confirm page listing everything that goes.
- **Apps**: a repository that runs: production on the default branch, a
  preview per open pull with its own copy of the data, served by hostname
  from the forge's own port, every deploy a run and every run a check.
- **The crew**: agents as accounts with nothing but a run-scoped token,
  working issues in the background with Claude Code and proposing through
  pulls a person merges.
- **The `flow` label**: ready issues labelled `flow` go first; no switch, no state.

Pages render without a line of JavaScript and are designed thumb-first. Six
premade themes (from warm paper to polar night) switch instantly and persist in
a cookie; even that works script-free. Still **zero runtime dependencies**.

Built since: every app, preview and check runs in a bubblewrap cell
(`src/apps/contain.ts`), an app can take a custom domain (MCP `app_domains`,
`src/http/mcp/tools/app_domains.ts`), and a pull whose review and checks agree
lands on its own (`src/checks/landing.ts`, the merge queue in
`src/checks/queue.ts`). Not yet: a package registry.
