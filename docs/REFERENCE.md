# forge reference

The long version: how it runs, its options and how it fits together. [`README.md`](../README.md) is the short one.

It runs the apps it hosts, and a **crew** of agents builds them. You describe
an app in a sentence; the sentence becomes an issue, and the agent it is
assigned to works it in its own fork and opens a pull. Every push redeploys
that pull's own preview — its own URL, on its own copy of production's data —
and every deploy is the check on that pull. No agent can move the default
branch, so the only way code reaches production is a merge a person made: the
crew proposes, you decide what ships.

That view is the **studio**, and it is the front door — a browser with no
`forge_mode` cookie lands there. It speaks four words for the whole loop:
_tell_, _working_, _look_ and _shipped_; an autonomous app lands its own
green changes, and nothing waits on a person. [`docs/STUDIO.md`](STUDIO.md) is the tour;
[`docs/APPS.md`](APPS.md) is the contract for apps, previews and runs. The
git underneath is one click away — the switch in the top bar, or `?mode=dev` on
any URL — and it is the rest of this page.

Slow app? Its response's `Server-Timing` keeps the app's entries and adds the
forge's `forge-route`, `forge-wake`, `forge-upstream`, `forge-ttfb`,
`forge-lag`, `forge-body` and `forge-rewrite` (milliseconds only; see
`docs/APPS.md`). When `forge-lag` is more than half of `forge-ttfb`, the wait
was the forge's, not the app's; a signed-in forge admin then also gets
`forge-stall;desc="<pattern>";dur=<ms>` naming the route or `job:<name>` that held
the loop (sent `private, no-store`; nobody else gets it).

A forge this one spawned (hosted) runs the apps it was given too: its `bakery`
answers at `bakery--<child>--<this forge's host>`, in this forge's lanes, on the
child's own data, and `/forges` says how many are running and why any is not. Each row also ends with the first step its person has not taken (`not claimed yet`, `no everyday account yet`, `no tell yet`, or `going: last tell <time>`; `has not reported yet` before the child's first beat), read from the child's heartbeat; the terminal's forges screen and the MCP `forges` tool (`nextStep`) say the same.
`/forges` opens with the forges side by side (size, memory/CPU/disk against it or "shared", apps, last heartbeat; `docs/features/forges-side-by-side.md`). The list leads with the forges that need you, each badged
with why (also in the terminal and the MCP `forges`): "Not reporting" (no word
in 24 hours), "App down", or "Unclaimed" three days after it was sent; the rest
follow by last activity.
A signed-out visitor's command palette (Cmd-K) lists only places they can reach (Home, Apps, Explore, Front page, Search, public repositories) plus **Sign in**, which goes where the topbar's button does (`signInHref` in `src/web/layout.ts`: `/signin`, `/signup` for an edge stranger, the edge's login when an edge token is active); no Create or Settings rows. After signing in from the palette the visitor lands on the default page, not the one they were on. The terminal's guest palette already hides the signed-in verbs (New repository, Migrate, New forge and the rest) and offers Sign in.

In the terminal an admin's palette offers "Forges you sent": each forge with its
claim state and the same apps-running note, never a claim link. Both carry the
crew's spend today against the daily ceiling that pauses it (`$3.20 of $10 today`), as the
child's heartbeat last reported it.

While the crew is on, the governor says how many builders it allows and why,
from the repository's own flow — pulls opened and landed in the last hour, and
how many open pulls are moving (`Builders 5 → 2: 30 pulls moving, 12 opened vs 2
landed last hour`; `src/crew/governor.ts`). It is the Governor row on the app
page's crew card and on Settings → Crew, always; on the terminal's home it
takes the repository's row only while the governor holds the crew below its
slots, and the row keeps its description otherwise; and `governor { slots,
ceiling, held, why }` on MCP `crew`; for people who can write here and the crew.

Each agent's scorecard — pulls landed of opened, review rounds, red checks,
reverts, time to land — is on Settings → Crew (`/settings/crew`) and in the
terminal's palette as "Crew scorecard per agent"; both are a forge admin's only.
The crew has three seats, planner, builder and reviewer (`seatsOf`, `docs/features/team.md`): Settings → Crew opens with "Your team", the MCP `crew` tool returns `seats`, and the terminal's About card (`I`) lists them, with `p` putting the first free agent on the first empty seat (a repository admin's).
The terminal's scorecard also ends each agent's row with `spend $ 5h · today · 7d`,
its cost over the last 5 hours, since 00:00 UTC and the last 7 days, as
`/settings/spend` reads it; `—` means nothing was spent in that span (`spend —`,
in all three).
Runs on P0, `opus`-labelled, planner and twice-bounced work use Opus (`docs/features/model-escalation.md`); the "Per model per day" spend and landed table is on Settings → Crew, in the terminal's "Crew scorecard" list, and in `GET /api/v1/crew/scorecard`.

**Weekly model review** (`docs/features/model-review.md`): once a week the forge reads its own ledger and moves each crew member to the cheapest model that holds its quality, or asks. A forge admin reads the verdicts and the trail, and answers an ask, in Settings → Crew ("Model review": *Move to …* / *Leave it*), in the terminal (`:` → "Crew scorecard per agent": the rows below the figures; put the cursor on a `waiting` row, `m` moves the agent and `n` leaves it, each after a `y` to confirm), in `GET /api/v1/crew/scorecard` and the MCP `scorecard` tool (`modelReview`). An ask nobody answers lapses after two weeks.
Settings → Crew also shows, each only when it has something, a "Handed to the
planner" card (issues the crew parked twice: repo, issue link, when last
parked, why) and a "Restore drill" card (the last drill's pass or fail and
when). The terminal's palette has the same as "Crew hand-overs", a list of the
same rows (repo#number, title, reasons): Enter opens a parked row's issue and
`r` reads the list again. Both are a forge admin's only.

Remove on a board panel asks first, on the confirm page, which names the panel and the board. The confirm posts the panel's index and title, and a panel at that index with another title is not removed ("that panel moved; nothing was removed"). The guard compares titles only: two panels with the same title swapped between the two clicks still remove the one now at that index, so give panels distinct titles (pins on home tell panels apart by title too).

`/boards` carries a Held files card for anyone who administers a repository (a forge admin sees every repository's): the holds of the repositories you administer, a form to hold another path, Release on each row, and "Showing 200 of N" when the list is cut. The user menu links Boards to such a person. In the terminal, a bare line on the Held files prompt lists the same holds.

A hold can be set "until green" (a checkbox on the hold form, `until: "green"` on the hold API and the MCP `hold` tool): when a check passes on the pull's current head the forge releases it and the pull's timeline says `hold released: green on <short oid>`. A plain hold is never released by a check.

In the terminal, `h` on the pull screen asks for a one-line reason and holds the pull (an empty or over-200-character reason is refused in the prompt, as on the web and in MCP); on a held pull `h` asks to confirm and lets it go. Both go through `holdPull` and `releasePull`, so the header shows `held by <who>: <why>`. `h` is offered to a person who can write only: an agent or a reader does not get it.

A forge admin's terminal home ends its forge strip with `Builders idle: <word> (<link>)` while no builder is starting anything: `ceiling reached` (/meter), `flow only` (/map), `no subscription with headroom` (/subscriptions) or `nothing ready` (/map). `idleReason` in `src/crew/idle_reason.ts` names it, asking the dispatcher's own predicates (`atCeiling`, the holds of `held.ts`, `pace`); it says nothing while a builder slot is busy or something can start. The web home tile is the next piece.

A hold an agent placed does not stand forever: the tick releases one still standing after 24 h, in one transaction, with a comment on the pull, "Hold expired after 24 h: <why>. Back to @builder.", which shows in the pull's timeline like any comment, and the pull goes back to its builder (`expireCrewHolds` in `src/actions/holds.ts`). A person's hold is never expired. The window is fixed; a pull held again and expiring again leaves one such comment per round in its timeline.

In the terminal, `T` on a shipped pull's screen takes it back, as the pull page's button does: a one-line confirm names the pull, Yes opens the pull that undoes it (`revertPull`, `src/actions/revert.ts`) and shows it, No changes nothing. The key appears only to a person who can write a local repository (never an agent, a reader, a guest or a mirror), and refusals read as the page's do (`takeBackWords`). `T` also opens an app preview's terminal on an open pull; a shipped pull has no live preview, so the two never meet.

In the terminal, `m` on a local repository's issue list opens the plan screen (`src/tui/screens/plan.ts`): Working, Ready now, Waiting and Parked twice, each headed with its count. It reads what MCP `map` reads (`repoGraph` under the reader's sealed scope, `pillarView`, `mapHeldFor`, the runs in flight), so a sealed issue the reader may not see is left out. Enter opens the issue, `r` reads again, and the headings are skipped over. It is not offered on the pulls list or on a live browse of another forge.

In the terminal, open a repository and pick **Autonomy** from the palette (`:`): mode, dollar ceiling a day and slots, as Settings › Autonomy has them. It is offered only to whoever administers the repository (`canAdmin`, an agent included, as the page's API allows); anyone else gets no entry and sees no value. `m` opens a confirm naming each mode and the ceiling, with Off, Assisted and Autonomous as its buttons and Cancel selected, so any mode is one pick away; `c` sets the ceiling, `s` the slots; bounds are the page's (`checkAutonomy`), and each saves through `updateRepoSettings` and says the page's flash (`AUTONOMY_SAID`).

In the terminal, a repository screen's `:` palette offers **Delete this repository** (`<owner>/<name> — Delete this repository`, "cannot be undone") to a person who administers it, never to an agent, a writer who is not an admin or a reader. It asks for the full `<owner>/<name>`; anything else is refused with "Type <owner>/<name> to confirm." and nothing changes. The exact name calls `deleteRepo` (`src/actions/repos.ts`, as Settings' danger zone does), toasts the result and unwinds the stack to the screen beneath the repository's (`leaveRepo`), so no screen reads the deleted row.

In the terminal, the palette's **Organization teams** (offered to anyone on a team of an organization) lists each organization's teams you may see, as `/<org>/-/teams` does (an org admin sees every team, a member only their own), each with its member count and permission; Enter lists the team's members. On that list an admin of the organization adds a person with `a` (type a username) and removes the member under the cursor with `d` after a y/n, in the Teams page's words. On the list itself the admin makes a team with `n` (a name, then read, write or admin) and deletes the selected team with `D` once its name is typed in full; anything else is refused with "Type <team> to confirm." and nothing changes. A member who is not an org admin is offered none of these keys.

The palette's **org grants** (a forge admin who administers the organization only; anyone else and any agent is offered nothing) sets the organization's default Claude subscription grants, as the Subscriptions form on its page does: `:` → `org grants`, Enter on the organization, `j`/`k` between everyone and the agents, `h`/`l` between accounts, `space` toggles the account and saves the row; every repository there without a grant of its own follows it.

In the terminal, the palette's **Connected origins** lists the hosts your mirrors come from (a signed-in person's, not an agent's): `s` syncs the selected one now, `d` disconnects it after a confirm; see `docs/ORIGINS.md`.

A writer puts a ready issue **First**: the dispatcher starts it before the rest, and the map's Ready now list (and the plan screen's) says `first, by <who>`. On the map page it is the First button on each ready row (a same-origin POST to `/:owner/:name/issues/:number/first`, no JavaScript; `Accept: application/json` gets JSON); in the terminal it is `f` on a ready line of the plan screen. Both call `putIssueFirst` (`src/actions/first.ts`). Refused, changing nothing: a reader or an agent ("Only someone with write access can put an issue first."), a signed-out post (sent to sign in), a read-only token, a cross-origin post, and an issue that is closed or still waits for another ("Only an open issue that nothing waits in front of can go first."). The rank ends when the issue closes, and it is an `issue.first` event, so open maps and plan screens refresh. No MCP tool yet.

A hand-over card on `/asks` (an agent's pull the reviewer stopped on after three rounds) has "Give back to the crew": one press assigns the pull, and the open issue it closes if a person holds it, to the agent that opened it, writes "Given back to the crew by @who", and the card leaves; the next tick starts its run. It is for a writer of the repository, and a pull a person opened, or by an agent gone from the crew, gets no button. In the terminal, `b` on a handed-over row of the On you pane does the same (`src/actions/give_back.ts`). The repository's planner can do it by comment: one that starts "Planner, one more round" on a handed-over crew pull emits the assignment to its builder, which starts the run (the pull is already the builder's, so nothing changes hands). It is the planner's alone; a reader's, the reviewer's or any other agent's does nothing. It is an agent's word, not a director's, so it does not end the hand-over: the card stays on `/asks` and the pull still counts as handed over during the round.

The terminal's On you pane leads with the board's strip, the week's asks as four numbers (`Asks, 7 days: 4 raised · 2 acted on · 1 dismissed · 1 went by themselves`, your own rows only, absent when all four are 0). It is read on load and on `r`, not on every paint; `W` opens `/asks` on the web. Both doors share `askMeasureWeek` in `src/core/ask_ledger.ts`.

Home opens with "Since you were here · 2 days": the pulls that landed in public repositories since you last loaded `/` (1 hour to 7 days back, a day on a first visit); the terminal's home shows the same lines, and MCP `feed` answers them as `digest`. See `docs/features/since-you-were-here.md`.
Signed in, `/` paints its frame from memory and swaps in what a write has made stale; a viewer whose access changed is never shown the old copy, and the terminal home is unchanged: `docs/features/home-frame.md`.

In the terminal, the System screen (palette: System) shows a forge admin who is a person one more line, `telemetry:read held by: …` (the agents holding the grant), and `g` there picks an agent and asks `grant <agent> telemetry:read? y/n` (or `take back …`; the default is n). `y` calls `setTelemetryGrant`, as MCP `telemetry_grant` does; anyone that tool refuses sees neither the line nor the key hint, and `g` answers them in the tool's words.

Crawlers (`docs/features/crawl-budget.md`): an unauthenticated crawler is held to a budget per address, per agent and all together, answered `429` past it; a forge admin reads their share of answering time and who was refused at `GET /api/v1/admin/crawlers` and in the terminal's palette as "Crawlers".

In the terminal, the Capacity screen (palette: Capacity, a forge admin who is a person) lists every guard with its live value and bounds, as /settings/capacity does; `e` on one asks for a value (empty restores the default), shows `key: from → to` and calls `changeCapacity` only on `y` (default n). No row is read-only here.

An admin's home and the terminal's Flow dialog also say when the forge is clogged and how long the last clog took to notice and to clear: `docs/features/clog-watch.md`. A fork whose parent is archived shows one quiet line instead of its ahead/behind count, and its admin can detach it from the parent (Settings › Danger zone, the terminal's About `x`, MCP `detach`): `docs/features/detach.md`.

**Templates:** `/forges/new` has a Template picker, Blank first (the default) or Starter app; the plan names the one chosen. In the terminal's New forge screen, tab to Template and press left or right (or type `starter`); the plan shows `Template: …`. Agents: `template` on `spawn`. Blank sends nothing.

**Forge it:** a **Forge it** button beside Fork on a repository page (and the terminal's palette entry `Forge it`) makes a fresh forge, named for the repository, with it as the app, and lands on that forge's claim link, where you pick a username and password and become its admin. A second press makes no second forge and shows no second link. Agents: `spawn` with `apps: ["owner/name"]`. `docs/features/forge-it.md`.

A pull the merge queue holds as red alone (red on its own merge at its current head; cleared by a new head or a moved main) says so under its checks line: "red alone at <time>, waiting for a new head or a new main", on the pull page, its live checks line and the studio change step, and in the checks row of the pull's terminal screen (`redMark` in `src/checks/queue.ts`). Nothing is drawn when it is not held.

On a sealed issue, a writer gets the private repository to fix it in: `POST /api/v1/repos/:owner/:name/issues/:number/private`, the issue page's button, and `p` on the issue's terminal screen, which shows the repository and its clone URL (built from the forge's origin). All three refuse alike: not found for anyone who may not see sealed reports, `not_sealed`, and `unverified`.

A writer seals or unseals an issue with `S` on the issue's terminal screen (readers are not offered it), after a confirm whose default is Cancel; Unseal is drawn as the danger button because it shows the report, and its fix, to everyone who can read the repository. It goes through `setIssueSealed`, as the issue page's Seal form does, and the toast says the page's words from `src/actions/seal_issue_words.ts`, refusals included: sealing an issue on a mirror is refused, since a mirror's issues live on its origin in the open.

When an open issue waits for a blocker that closed as dropped or split, the terminal's issue screen pins a line under the title, "waits for #N (dropped), closed without being done". A writer who is a person (not a reader, not on the crew) sees `g` there: after a confirm (Cancel is the default) it calls `confirmIssue`, as the issue page and MCP `confirm_wait` do, and the line goes. With several blockers held, `g` first asks which one (or all of them).
An issue's title and body are edited on its page, with MCP `edit`, or with `e` on the issue's terminal screen: the editor opens with the title on the first line, a blank line, then the body; `ctrl+d` saves and `esc` discards. All three go through `editIssue`, so the same people may (the author until a writer takes it up, any person who writes the repository; never on a mirror) and a refusal reads the same, with the terminal's draft kept.

Reports from outside (sent with no account) are decided in the terminal too: open the repository as a person who writes it, press `:` and pick "Reports (N)"; beside each title is when it was sent, the page it came from and its words. `a` accepts the one under the cursor as an issue and says its number, `d` dismisses it after a confirm, and one someone else already decided says "this report was already decided". The row shows only while reports wait, and only to a person — not an agent — who can write the repository (`src/tui/screens/reports.ts`).

**A pull the access wall holds** (a pull whose `contract.json` opens a door wider, or does not read) says a person decides, in plain words: "anyone signed out could read address records". Its pull page and Files tab show the card; a writer (and only a writer) also gets **Allow it and merge** (the merge route, `mergePull`) and **Send it back** with an optional visible reason (the review-state route, a request for changes); readers see the card without forms. In the terminal's pull screen a writer presses `w` for the same two answers in one dialog (`Send it back`, `Allow it and merge`, squash), through `submitReview` and `mergePull`, which check the write. MCP `flow`, the flow alarm and the audit page's "at the wall" rows carry the same words.

**Landing past a stopped gate** (#7790): when the last three merge-queue gates of the forge's own repository went red for one cause and nothing has landed since, home, `/boards` and the terminal's Flow dialog (owners only) say `Landing has stopped: …`. Only then can an owner (repository admin, a person, never an agent) land one named pull without its checks, with a reason of 8 to 500 characters that goes on the pull's trail and the outbox (`pull.bypassed`): the **Land past the gate** form on the pull's Files step, `L` on the terminal's pull screen (reason, then a confirm), or MCP `land_past_gate` (planned unless `dryRun: false`). Review and conflicts still hold. `docs/features/gate-bypass.md`.

**Taking a shipped pull back**: `POST /api/v1/repos/:owner/:name/pulls/:number/take-back` (a person who can write here, `rw` token scope; a session needs a same-origin request) opens a new pull, `Revert "<title>"` from the branch `revert-<n>` into the default branch, that undoes exactly what the shipped pull merged. Nothing lands until a person merges it. It takes no body and answers 201 with the new pull, as `POST …/pulls` answers one. Refusals: an agent or a reader gets 403 `forbidden`; a read-only token gets 403; a pull that is unknown or that you may not see gets 404 `not_found`; 409 `not_shipped` (it never merged), 409 `already_reverted`, 409 `mirrored` (the origin owns the history); 409 `conflict` when the undo no longer applies cleanly, with the conflicting files in `message`, and nothing is left behind. A failure of the forge's own git is 500 `git_failed` with a fixed message; git's words go to the server log. The pull page's **Take back** is the same verb (`revertPull` in `src/actions/revert.ts`). The terminal's pull screen does not offer it yet.

The terminal's history says each commit's check, as MCP `commits` with `oid` does: a ✓ or ✗ mark on a log row where the commit's own check on the default branch passed or failed (blank where it has no verdict yet), and a `check:` line under one commit's title: `green`, `red · <first line of the failing step>`, `running`, `superseded` or `not run`, with `· via <sha>` when a later main commit's check answers for it. Nothing shows to a viewer who may not read the repository's runs (`src/checks/commit_check.ts`, `src/tui/screens/commits.ts`).

The web history says it too (`/:owner/:name/commits`): a commit whose own check passed or failed wears the check badge, Passed or Failed, linked to that check's run with the commit and the failing step in its accessible name; one with no verdict wears none, and nothing shows to a viewer who may not read the repository's runs. One commit's page (`/:owner/:name/commit/:oid`) opens with the check in a sentence: passed, failed with `first failing <step>`, running or superseded, with "(the check of <sha>, which contains it)" when a later main commit's check answers for it, and nothing where no check ran. The list reads its verdicts in one query per page (`verdictsOfCommits`); live-browse pages of another forge show none.

In the terminal workspace a `.csv` or `.tsv` file opens as a table (columns padded to their widest cell, the header kept on top, `N rows` in the status line; at most 1,000 rows and 64 columns are drawn and the rest is counted; a cell wider than 32 columns is cut with `…`, and the source view shows it whole). `s` flips between the table and the source, and a file that does not parse opens as source with `not a table: line N` in the status line (`src/text/csv.ts`, `src/tui/ui/grid.ts`).

Under the agents, each team that has a pull has one pooled row (its members'
counts added, the ratios taken from the sums; an agent on two teams counts in
both): `data-team` rows on the page, "team <name>" rows in that terminal screen.
Landed, review rounds and red checks stand as the last 30 days (pulls opened
since then) beside all time, so tuning an agent shows as movement; reverts and
time to land are all time. Under each agent, a sub-row per model and prompt
version its pulls ran on (the agent's latest run on the pull decides) carries
the same figures, so a change of model or brief shows against the one it
replaced; pulls opened before runs recorded either read "unrecorded", and are
counted, never dropped. The sub-rows list every pairing ever used; a pairing
unused in the last 30 days shows dashes there. The terminal shows them as
indented `↳` rows.

Scripts and agents read the same figures as JSON: `GET /api/v1/crew/scorecard`
and the MCP `scorecard` tool answer `{agents:[{username, all, recent, splits:[{model,
prompt, …figures, recent}]}]}`, where `all` is all time and `recent` the last 30
days. A ratio over nothing is `null`, and an agent with no pull has `all` and
`recent` null. Any token of a forge admin may read it (401 with none, 403 for
anyone else); the tool is listed for admins only.

A crew clone's dependencies are installed before the agent starts
(`installDependencies` in `src/crew/workdir.ts`), once per lockfile hash, so
the type check has its types. That install runs on the forge side, outside the
agent's shell sandbox, because the sandbox is built around the agent and the
install has to finish before it starts. It is bounded instead: a child env of
`PATH`, `HOME`, `TMPDIR` and the repository's install cache only (no `FORGE_*`
variable or key), `--ignore-scripts` so no package runs code, `--frozen-lockfile`,
and a 120 s kill. What remains is the registry and tarball fetch, which a
repository's `bunfig.toml` can point at a host of its choosing; that is the same
reach the agent's own `bun install` has through the sandbox's allowed hosts, and
a failed or killed install only logs and lets the run start.

Git hosting, code browsing, and a JSON API in one fast Bun process, with
**zero runtime dependencies** — the `package.json` dependency list is empty and
stays that way. The dev-only exceptions are listed under Dependencies below;
none ships and the app never imports them. Everything worth having is written here: the Result type, the
router, the SSR templates, the design system, the markdown renderer. The only
thing forge asks of the host is a `git` binary.

## Dependencies

Every package in `package.json`, with why it is there. A package with no line
here fails `test/dependencies-named.test.ts`; so does a line for one that left.

- `@anthropic-ai/sandbox-runtime` — lets `test/crew-sandbox-real.test.ts` run a shell under the very sandbox Claude Code builds from the crew's settings.
- `@types/bun` — the type check's types for Bun's own APIs.
- `@vscode/ripgrep` — the `rg` that `srt` scans with, pinned and shipped in the package (no install script), so `test/crew-sandbox-escape.test.ts` runs on a check host with no ripgrep of its own.
- `axe-core` — the release check's accessibility rules (`src/release/axe.ts`); they need a rendered page, and there is no zero-dependency equivalent.
- `happy-dom` — a DOM for tests that run a page's script (`test/changelog.test.ts`) without a browser.
- `typescript` — the native 7.x checker behind `bun x tsc --noEmit`.
- `typescript-api` — TypeScript 5.x, kept only for the compiler API `scripts/hollow.ts` walks; 7.x has none yet.

Forgejo is the reference for what a forge should _feel_ like. This is that
feeling on a foundation sized for one person.

## Run it

```sh
bun install          # dev-only: types + tsc (native, 7.x), no runtime deps
bun run src/main.ts  # web on :3000, ssh on :2222 (FORGE_SSH_PORT=0 turns it off; a taken port turns it off with one warning)
bun src/main.ts --preflight  # can this tree boot? config parses, migrations run on a copy of the database; one line, exit 0 or 1, no socket opened. Run it before the swap, not under load: the copy is not atomic against a live writer, and a `preflight-*` directory a killed run left behind is swept by the next run once an hour old, and a missing data directory is created, as boot would
bun src/main.ts --rollback <sha>  # swap back to a kept release: a full 40-hex sha under $FORGE_DATA/releases/, PORT as the running forge's. Exit 0 once that release reads healthy as that sha, else 1 with one line
bun src/main.ts --first-admin  # a forge with no admin: print a one-time code that makes one (below)
```

Apps and agent runs are contained only where `bwrap` (bubblewrap) and `socat`
are on `PATH` (Linux); without them they run uncontained, and the boot log says
so. The crew also needs the `claude` CLI and a model credential.

The container image pins Bun to an exact patch release in `Dockerfile` (`test/dockerfile-pin.test.ts` refuses a floating tag). To move it, change that one `FROM` line, run the check, and watch the first hour of `/system`.

Set `FORGE_REPO=owner/name` to the forge's own code and a pull the crew lands there is written to `$FORGE_DATA/releases/<sha>/` (the newest `FORGE_RELEASES_KEEP`, default 5, are kept), preflighted with that tree's own `--preflight`, and recorded in the `release` table (sha, landed pull, verdict, its line, when). A red preflight is asked again once (the copy of the live database can tear under load); a second red is logged and told to the landed pull. Other repositories are untouched, and nothing is swapped unless `FORGE_SELF_SWAP=1`: then the forge binds its port with SO_REUSEPORT, a green release is started from `releases/<sha>/` beside it on the same port (`FORGE_COMMIT` set to the sha), `/api/v1/health` is read until an answer names that sha and is well (`FORGE_SWAP_BUDGET_S`, default 60), and only then does this process drain as a SIGTERM does — except that it stops accepting at once, so every new connection is the release's, and answers what it already holds (a long push or clone) to the end, for up to five minutes, before it closes. A release not healthy in its budget is killed, the old keeps serving, and the log and the landed pull say so. One swap per process: a landing while another swap is in its budget, or after one succeeded, is released and recorded but not started (the new process runs it from the next restart). The SSH terminal is not handed over yet (the new process cannot bind the old one's port), so a process holding the SSH listener refuses the swap and tells the landed pull; run with `FORGE_SSH_PORT=0` to swap. The swap also needs `net.ipv4.tcp_migrate_req=1` (Linux 5.14+): without it the kernel resets the connections still queued on the old listener when it closes, so a swap is refused (and told to the landed pull) rather than failing requests. The release is a child of the old process, so the swap is for a forge run directly, not under a supervisor that kills its children when the old process exits (PID 1 of a container, a systemd unit with the default `KillMode=control-group`). SO_REUSEPORT lets any process of the forge's user bind the same port and take a share of its connections, so `FORGE_SELF_SWAP=1` assumes nothing else runs as the forge's user on the host network (agents and apps are sandboxed or in cells). `--rollback <sha>` starts the kept release beside the running forge by the same health-read swap (`FORGE_SWAP_BUDGET_S` does not apply: it waits the default 60s), and a release that is not healthy is killed with the old still serving. It refuses, with one line and exit 1, a sha that is not kept (never checked out, or pruned) and a release whose schema has fewer migrations than the live database has applied (`<sha> predates schema N; rolling back would need a down-migration`); a release with a newer schema is allowed, as it migrates forward on boot, and the database's refusal of a future schema is unchanged. It does not drain the forge that was serving: until part 2 of the rollback does, both processes share the port and the operator stops the old one (the command prints that). It does not check `tcp_migrate_req` or SSH either; stopping the old process cleanly needs the same `net.ipv4.tcp_migrate_req=1` setup as the swap, and the SSH port stays with the old process. `/releases` lists the kept releases (short sha, landed pull, when, and since when the live one has been healthy: this process's start); a person who writes the `FORGE_REPO` repository (never an agent: the button is hidden and the POST is a 403) gets a Roll back button on a kept, schema-compatible release, which runs the same refusals and swap and then drains this process (so it needs `FORGE_SELF_SWAP=1`); only readers of that repository and site admins see the page and the home line (anyone else gets a 404), and the forge's SSH terminal has the same, gated the same (`src/release/gate.ts`): the palette's `Releases` shows `live: <sha> since <time>` and the kept releases, only to those readers, and Enter on a rollable release asks to confirm then runs the same rollback as the button (a person who writes the repository only, never an agent; told when `FORGE_SELF_SWAP` is off); the home carries a `live: <sha> since <time>` line linking there. A script reaches the same rollback at `POST /api/v1/admin/releases/<sha>/rollback` with an admin-scope token: it plans by default (`{from?, to, allowed, message?}`, nothing moves), `{"dryRun": false}` applies it, and the same people and rules apply as on the page (never an agent). `FORGE_REPO` also names the parent code that spawned child forges fork.

Which repository is the forge's own source can also be set by an admin, without touching the deployment: `PATCH /api/v1/admin/settings` with `{"forgeRepo": "owner/name"}` (`null` clears it; `GET` answers `forgeRepo` and `forgeRepoInForce`), falling back to `FORGE_REPO`. For that repository only, its app is shown as a test copy: its production link reads the forge's canonical URL and `…/app/production/open` goes there, the app's own host is listed as "Test copy", and pull previews are unchanged. It is display only (`src/settings/forge_source.ts`): nothing routes by it, the forge's hostname is still refused as an app domain, and the release paths above still read `FORGE_REPO` alone.

**Keeping a domain drill**: `POST /api/v1/drills` (a site admin person; an agent is refused with 403, and a session needs a same-origin request) takes `{domain, seen:{health, board}, backSeconds}`: a domain key from `docs/DOMAINS.md`, what the drill read from health and the board (text, at most 8000 characters each), and whole seconds until the forge was well again (0 to 31536000). The body is capped at 32000 bytes (413). It answers 201 `{id, domain, backSeconds, green, why}`: the verdict is judged against the domain's own words and kept whether green or red. An unknown domain, bad `seen` or bad `backSeconds` is 422. Kept drills are read back on **Settings → Backups**, in its **Failure domains** card (`docs/SNAPSHOT.md`). To run a drill by hand, `FORGE_TOKEN=… bun scripts/drills/run.ts <domain> --forge <url>` (plain `http` is refused unless the host is loopback or you pass `--insecure`) prompts for the fault, watches health and the board until the forge is back, and posts this for you (`docs/DOMAINS.md`).

**Re-checking a shared red**: `POST /api/v1/repos/:owner/:name/checks/recheck` (a repository admin, `admin` token scope; anyone else gets 404, and a session needs a same-origin request) takes `{test}`: the name of one failing test exactly as the check log's failing names show it, 1 to 300 characters (otherwise 400). It asks again, through the ordinary check queue, for every open pull whose latest check on its current head failed on that test, and answers `{queued: [pull numbers]}`. At most 50 pulls are queued per call; when more were red, the answer adds `more` (how many were left) and a `message`, and a second call takes the rest. A pull waiting for a writer's approval, or whose head declares no check, is not in `queued`.

If your shell already has `FORGE_URL` set — a crew workspace sets it to the
forge you work for — this forge takes it as its own canonical address and
refuses every form a browser posts to `localhost`: run it with
`env -u FORGE_URL bun run src/main.ts`, or set `FORGE_URL` to wherever you
will actually browse it.

Who may sign up (open, invite or closed) is shown on the terminal's Invite
links screen, and a forge admin who is a person changes it there with `s`,
which shows from → to and changes it only after a confirm (as MCP `signup` does).
A used link reads `used by <name> on <yyyy-mm-dd>` there and in Settings ›
Limits, where the name links to the person's profile.

No sign-up makes the admin, not even the forge's first, and that first one is
held to the signup setting and Turnstile like any other. Accounts sign up with
a passkey and an email address (there is no password signup), and the browser
at `/signup`, the API and the terminal all make an account that is not an
admin. The site admin is made from the operator's terminal with
`--first-admin`, which needs no browser at all and works whatever signup says,
or, on a spawned child, by its `/claim` link (code that sets a forge up
directly, like test fixtures, seeds one):

```sh
# One-time code, printed only here: works once, for 15 minutes, and never once
# anyone is admin. --child <name> mints for a child this forge hosts; --url
# names the address to print. The forge keeps only its hash. Run it beside
# the running forge with the same FORGE_DATA (and PORT, or --url, for the
# link); before the forge's first boot there is no database and it refuses.
bun src/main.ts --first-admin

# A person opens the printed link and makes the admin with a passkey.
# A headless agent trades the part after "#" for a token instead:
TOKEN=$(curl -sX POST localhost:3000/api/v1/first-admin \
  -d '{"code":"<code>","username":"you","email":"you@forge.dev","scope":"rw"}' \
  | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

curl -sX POST localhost:3000/api/v1/repos -H "authorization: Bearer $TOKEN" \
  -d '{"name":"hello","visibility":"public"}'

git clone "http://you:$TOKEN@localhost:3000/you/hello.git"
```

`POST /api/v1/first-admin` takes `{code, username, email, scope, name?,
expiresIn?}` (`scope` is `ro`, `rw` or `admin`; `name` names the token) and
answers 201 once with `{user, scope, id, token, expiresAt, expiresIn}`. The
token always expires: in a day (86400 seconds) unless `expiresIn` asks for
whole seconds from 60 to 2592000 (30 days); anything else is 422
`invalid_expiry` and spends nothing. The account has no password or passkey and
a token cannot mint tokens, so once its token lapses it cannot sign in.

If that leaves no admin with a working credential (no password, passkey,
unexpired token, live session, SSH key or sign-in with the parent), running
`--first-admin` again prints a recovery code for the stranded admin instead
(`--user <name>` picks one when there are several). It has the same rules: it
works once, for 15 minutes, only its hash is kept, and it is rate-limited. Send
it to `POST /api/v1/first-admin/recover` with `{code, scope, name?, expiresIn?}`
and you get back a new expiring token for that existing admin, in the same
shape as above. No account is made, and each kind of code is refused at the
other's door. The command refuses, and a live code dies, as long as any admin
can still sign in. The audit records it as `user.recovered` with
`via: first-admin-recovery`. Every refusal of the code (wrong, used, expired,
replaced, or the forge already has an admin) is the same 403. Every attempt, at
either door, is counted before the code is read, per address and for the whole
forge, at the sign-in limits (429 past them). The account made is in the audit
as `user.created` `via: first-admin`, and the sign-in page links `/first-admin`
only while the forge has no admin. Later tokens come from Settings → Tokens, or
`POST /api/v1/tokens` from a signed-in session with `{"name", "scope"}`; the
admin adds `"adminConfirm": true` to mean a token that acts as admin. `ro` and
`rw` are open to anyone; a member asking for `admin` gets 403 ("Only an admin
can make a token with admin scope; ro and rw are open to you."), and the
Settings form offers `admin` only to an admin.

**The forge's agent acts as you, and the trail says so** (#7648): `POST
/api/v1/conversation-tokens` with `{"words": "<what you said>"}` mints the
token the forge's agent acts with in a fresh conversation; add
`"conversation": "<id>"` to go on with one of your own (any other is 422
`invalid_conversation`). Only your own browser session on the same origin
mints it (a bearer token or a password is 401, a cross-origin post 403). It
answers 201 once with `{id, token, expiresAt, via}`: the token is `rw`, holds
exactly what you hold, reaches the forge only through `/mcp`, fenced
(docs/features/conversation-fence.md), and expires within the hour. Every
event written while it is the caller has you as its actor and `via:
"conversation:<id>"`; what the forge writes on the way (a run, a check) is
not marked. The trail reads "alice via the forge's agent": MCP `events` and
`GET …/events` add `by` with those words, and an issue's or pull's timeline
says "alice via the forge's agent closed this".

The same token spawns a child forge (`dryRun` is true unless `false`, so
without it you get the plan and nothing is made). The child's admin comes
from the operator's `--first-admin --child`, or from the `claimUrl` the spawn
answers once:

```sh
curl -sX POST localhost:3000/api/v1/forges -H "authorization: Bearer $TOKEN" \
  -d '{"name":"kid","dryRun":false}'
# {…, "url":"http://kid--localhost:3000", "claimUrl":"http://kid--localhost:3000/claim#…"}
bun src/main.ts --first-admin --child kid
```

The child keeps this forge's scheme and port at `<name>--<host>`, on its own
data under `$FORGE_DATA/children/`. Browsers send `*.localhost` to this
machine; curl needs `--resolve kid--localhost:3000:127.0.0.1`. The rest is in
`docs/SPAWN.md`.

The commits the forge writes for you — merges, squashes, reverts, web edits —
carry `you@users.noreply.<forge host>`, never your account email. Choosing your
real address is an opt-in under **Commit email** in `/settings` (or
`PATCH /api/v1/user` with `{"commitEmail":"account"}`); commits you push
yourself carry whatever your own git says.

### Attaching the Claude app or Grok (OAuth)

Add a custom connector with the URL `https://<your forge>/mcp`. The client
registers itself at `/oauth/register` (the Claude app's callback is
`https://claude.ai/api/mcp/auth_callback`), sends you to `/oauth/authorize`
to sign in and choose `ro` or `rw` and a token name, then exchanges a
single-use 60-second code with its PKCE S256 verifier at `/oauth/token` for
the same token Settings mints; revoke it there. Details in `docs/MCP.md`.

### Proposal tokens

A writer of a repository can hand a child (a fork, or a project on another
forge) a credential that reads this repository's code (so the child's forge can
fork it), proposes, and nothing more:

```sh
curl -sX POST localhost:3000/api/v1/repos/you/hello/proposal-tokens \
  -H "authorization: Bearer $TOKEN" \
  -d '{"child":"kid","origin":"https://kid.example.com/","childRepo":"kid/hello"}'
```

`child` is lowercase words and hyphens; `origin` an https address;
`childRepo` (optional) a fork of this repository, and deleting it deletes the
token, as does deleting the repository. The token expires in 30 days. It is
listed as `proposal:<child>` among your tokens, and revoking it there ends it.
Over HTTPS it clones and fetches this one repository (private or not; no other
repository, secret, app or issue; a fetch sees every branch, other children's
`child/*` included), pushes only `child/<name>/…` branches of this repository (anything
else is refused with one line) and `POST …/pulls` from one of them, with a
body of at most 64 KiB and 20 requests a minute. Every other request is a
403, decided in `src/http/proposal_gate.ts` before any handler runs. A proposed pull
runs no check and no preview until a writer approves its head or lets it run
(**Let it run here**, which is not a review; a new push waits again), and a bare push to `child/…` starts none. A pull
opened with it says "proposed by child … from …" on every tab of the pull's
page, in the terminal's pull view, and as `proposal` in the pull's JSON
(`GET …/pulls/:number`, and MCP's `pull` tool). `GET …/pulls/:number?diff=0` reads the pull without its diff (and skips computing it); `diff` is `0` or `1`, default `1`, and anything else answers 422. `GET …/issues?fields=brief` lists issues with only number, kind, title, state, labels, assignee, author, originAuthor, authorIsAgent, createdAt and updatedAt (and `untrusted` where it applies); no bodies or comments. `fields` is `brief` or left out, and anything else answers 422 `invalid_fields`. `GET …/repos/:owner/:name/events` answers `{ items, next_cursor }`, newest first, `limit` 1 to 200 (default 50) and `cursor` from `next_cursor` (anything else is a 422); it used to answer a bare array of every event, so a client that read the array reads `items` now. A request reads at most 1,000 events, so when most of them are hidden from the reader a page can come back short with a `next_cursor`: keep following it until it is null. MCP's `events` tool answers the same. Both take `kind` to keep one event kind; every `repo.settings_updated` carries `changed: { setting: { from, to } }`. `GET …/repos/:owner/:name/branches` answers `{ items, next_cursor }` in the order it always had, `limit` 1 to 200 (default 50) and `cursor` the `next_cursor` of the page before (the name of the last branch on it); anything else is a 422, and a cursor naming a branch deleted between two requests is `invalid_cursor`, so start over. It used to answer a bare array, so a client that read the array reads `items` now. `GET …/repos/:owner/:name/forks`, `…/labels` and `…/hooks` answer `{ items, next_cursor }` too, in the order they always had, `limit` 1 to 200 (default 50) and `cursor` the `next_cursor` of the page before (the id of the last row on it); anything else is a 422, and a cursor naming a row deleted between two requests is `invalid_cursor`, so start over. They used to answer a bare array, so a client that read the array reads `items` now. `GET …/repos/:owner/:name/hooks/:id/deliveries` answers `{ items }`, a webhook's last twenty deliveries newest first (id, kind, state, attempts, lastStatus, lastError; never the secret or a payload). It needs an admin-scope token on a repository you administer, and answers 404, not 403, below admin scope, for another repository's hook and for one that does not exist. MCP's `hooks` tool answers the same with `action: deliveries` and `id`.

### Proposing to a parent forge

A spawned forge can offer its change to its parent with a proposal token, and an admin sets how it follows the parent. Details, API, MCP and terminal doors: [`docs/FOLLOWING.md`](FOLLOWING.md#proposing-to-a-parent-forge).

The terminal's launcher search (`/`) is the explorer when the line has a
`kind:` or `sort:` word: `kind:app sort:forks garden` ranks as `/explore`
does, by the same action, with each row's forks, merges, hours in use and
freshness, and a "Read as:" line says how the line was understood. Enter on an
app opens it; a person or forge row has no terminal page and says where the
web has it. A plain line still matches your repositories by name.
An unknown `kind:` or `sort:` word is dropped and named after "Read as:", with
the words it takes, on the page, in the terminal and in a `note` field of
`/api/v1/explore` and the MCP `explore` tool; results still show.

A signed-out visitor to `/explore` sees **Make it yours** on every public app (not on a private one, nor one only its writers may enter); it leads to sign-in and back to the plan of their copy, and nothing is copied until they confirm. Behind a platform edge the sign-in is the edge's; a newcomer it vouched for is sent to `/signup` and may need to come back. API and MCP rows say `copyable: true` for a guest too; making the copy needs a signed-in caller, and the terminal is always signed in and offers `Y` on the repository screen.

## On your machine

The `forge` command keeps a local copy of the parts you work on: **[docs/ON-YOUR-MACHINE.md](ON-YOUR-MACHINE.md)**.

A fork chooses how it follows its parent: **tell me** (the default: a fork with nothing of its own is fast-forwarded, one with work of its own is left diverged and the crew is told) or **take updates** (when the parent moves, a diverged fork is also merged for its owner whenever git merges it cleanly; a conflict is still told, never forced). On the web, the fork's owner picks it in the Following card on the fork's home page (`POST /:owner/:name/following/mode`); in the SSH terminal, open the fork's Forks screen and press `m` to flip it; MCP's follow-mode tool and the JSON API reach the same `setFollowMode` action. The choice lives in `fork_follow` (`src/core/fork_follow.ts`).

## Develop

Tests, checks, the gate, lint, types and how a change reaches main: **[docs/DEVELOP.md](DEVELOP.md)**.

The gate also refuses unreached modules. `test/unreached.test.ts` runs
`scripts/unreached.ts`, which lists each `src/**/*.ts` no entry point reaches
by following imports (the entries, including those started by path, are
declared at the top of that script; anything under `scripts/` counts as a
caller too). A new one fails the test unless
`scripts/unreached-allow.json` lists it; wiring a listed module in means
deleting its line, which the test also demands. `bun scripts/unreached.ts`
prints the list.

## Shape

```
src/
  main.ts     boot
  app.ts      composition root (one data dir = one forge)
  kernel/     zero-dep primitives: result, error, id, log, db, hash
  git/        bare repos, smart HTTP v2, cat-file readers, hooks, guards
  core/       domain: users, sessions, tokens, repos, events, schema
  actions/    every mutation once: authorize, mutate, record the event
  http/       router, request context, the server
  design/     the theme registry both surfaces render
  web/        SSR: html tag, design tokens, markdown, pages
  ssh/        a zero-dependency SSH server: transport, userauth, channels
  tui/        the terminal UI: runtime, widgets, screens, the ssh front door,
              and local/ — the same runtime over your own working trees
  cli/        `forge` on your machine: login, sync, status, pins
  apps/       a repository that runs: manifest, checkout, process, data,
              the runtime (environments), the proxy by Host
  runs/       run logs, appended live
  crew/       agents as child processes: the brief, Claude Code headless,
              the runner, dispatch off the outbox
```

Read `docs/ARCHITECTURE.md` for the principles and the reasoning behind them.
Contributing (human or agent) starts at `CLAUDE.md` — the invariants and how to
work here.

## What works today

Every pull says which of four steps it is at — check, review, land, live — and why it waits there: a line under its title on both tabs (linked to `/pipeline`, a public page that explains the four steps), `step: { step, why, done }` in the MCP `pull` tool, and `step: …` in the terminal pull screen's header; the same word and sentence sit on the pull's post in the feed, its row on the pulls list and on `/review` (each linked to `/pipeline`), and in the terminal's feed, pulls list and on-you list (`Review — No review yet.` under the row). The whole suite is a report, not a gate: after a landing it runs against the default branch and each failing test file gets one issue labelled `full-suite` (listed from `/pipeline`; the terminal's Flow dialog counts the open ones and the issue list filters by label with `l`). See [`docs/features/pipeline.md`](features/pipeline.md).

A public app of a public repository tells an agent that lands on it what it can
do: its HTML pages, and the "not running" page, carry two `Link` headers —
`rel="help"` to `/__forge/report` and `rel="alternate"` to the forge's
`/api/v1/here?path=/<owner>/<repo>` manifest (`discoveryLinks`,
`src/apps/proxy.ts`). A private app, a nested host and non-HTML answers get none.

Open an image or SVG in a repository and it is drawn, fit to the pane. Press
**Actual size** (or click the picture) for 100%; the pane scrolls or drags to
pan. The header shows its pixel size, file size and format; **Source**,
**Raw** and **Download** stay beside it. The terminal's file view draws a
binary picture where the terminal can, and otherwise names the file and its
size; SVG there shows as its source text.

A model key is taken as pasted, wherever one is given (Settings →
Subscriptions, MCP `subscription_add`, the terminal's Crew subscriptions
screen `a`, a new forge's
`modelKey`): every space, line break, non-breaking or zero-width space and a
leading `Bearer ` are dropped (`normalizeToken`, `src/core/subscriptions.ts`),
and what is left is sealed if it is not empty and at most 4096 characters. Its
shape is not judged; the provider answers a wrong key on the first call.

The terminal's Crew subscriptions screen lists every account with its 5-hour
and weekly windows under its row: used of cap, the share, and when it resets,
in the very sentence Settings › Subscriptions prints (`windowWords`,
`src/actions/standing_words.ts`). A sentence wider than the terminal wraps
onto the next line, so the reset time is never cut off.

Inside a repository, the palette's Crew grants (`src/tui/screens/grants.ts`)
sets which subscriptions each crew member may use there, as Settings › Crew
does: one row for everyone on the crew and one per crew member, each
subscription by name and kind (never its token) on its own line under the row.
`j`/`k` choose the row, `h`/`l` the subscription, and `space` toggles it and
saves the row whole through `setGrants`. Nothing ticked removes the row's
grant, and the wider one applies: the owner's grant, or the forge's own token.
It is offered to a person who is both a forge admin and an admin of the
repository; anyone else, and every agent, is offered nothing. Settings › Crew
shows a save on its next load.

A repository in auto mode with a direction and no planner on its crew is lent
one (#7637): at the next planning turn the forge adds, through the same
`addToCrew` an admin uses, the agent that plans on the most of the *owner's*
other repositories, and hands it the direction. If the owner has none, or the
autonomy actor may not add it, nothing is lent and the reason shows in the
Direction field of the autonomy card (admins), the terminal's Vision screen,
and MCP `vision` as `directionStall`.

The running list of what the forge does, one bullet each, lives in
[`docs/STATUS.md`](STATUS.md).

A milestone says how fast it is moving in one line — `on pace for <date>`,
`no movement in 7 days` or `done <date>` — with issues closed per day over 14
days drawn beside it, on its page, in the terminal's Milestones screen and in
the MCP's `milestones` tool (`closedPerDay`, `paceDate`); `docs/PLANNING.md`
has the rule.

### The throughput keeper

Once a minute the forge measures its landing rate, names the one cause binding it, and lifts Flow only or unsticks assigned issues when that is its to do; if landings do not rise in 2 h it puts the switch back and asks the owner one question with one button. It shows as a line on home and `/boards` (a site admin sees repository names; everyone else a repository-free cause), in the MCP `flow` report, in the terminal's Flow dialog (`l` answers) and as "Forge per day" on the crew scorecard. No model, no dependency. See `docs/features/keeper.md`.

## Where the rest is

- [`README.md`](README.md): the documentation index, by what you want to do.
- [`REFERENCE.md`](REFERENCE.md): this page.
- [`WRITING.md`](WRITING.md): how to write documentation for the forge.
- [`docs/DEVELOP.md`](DEVELOP.md) — developing the forge: tests, checks, the gate, lint and types.
- [`docs/SECURITY-RUNBOOK.md`](SECURITY-RUNBOOK.md) — what to do, with no AI, if the forge is under load, a token leaks or an account looks wrong.
- [`docs/STATUS.md`](STATUS.md) — what works today, one bullet per feature.
- [`docs/ON-YOUR-MACHINE.md`](ON-YOUR-MACHINE.md) — the `forge` command on your machine: the local copy, offline work and building the binary.
- [`docs/web.md`](web.md) — the rules for assets and HTML: what is cached where, how a page streams, and the byte budgets a test enforces.
- [`docs/PRINCIPLES.md`](PRINCIPLES.md) — what the forge holds to, each with what enforces it; capped, and read by the crew and the in-forge conversation.
This page is the front door. Everything else is a file of its own under
`docs/`, each about one thing:

**Using it**

- [`docs/VISION.md`](VISION.md) — what the forge is for, and the order of work.
- [`docs/STUDIO.md`](STUDIO.md) — the front door in full: the five words and where each is decided, the box, the three lists, a tell, a run and a change each on its own page, and the board.
- [`docs/TOUR.md`](TOUR.md) — every other page and screen, with each of its doors: the terminal over SSH, the home and its figures, review, signing in, the page-view beacon, the board's notes, long threads, who can see a repository, archive, where a repository came from, big directories, search, sharing to the forge, link-preview cards and choosing among variants.
- [`docs/ASKS.md`](ASKS.md) — what waits on you and how to answer it: waiting pulls, mutes, wave proposals, feed chips and the decider.
- [`docs/FEED.md`](FEED.md) — the feed: what happened, ranked, each item with why it is there. The home composer keeps your draft across a reload. A post about an issue or pull offers Reply, which comments on it and returns to the feed; the terminal's Feed screen replies with `r`.
- [`docs/PULLS.md`](PULLS.md) — resolving a conflicted pull without a clone.
- [`docs/GIT.md`](GIT.md) — cloning over HTTPS and SSH, and partial clones of big repositories.
- [`docs/CLI.md`](CLI.md) — the `forge` command on your machine: install, log in, and every command with its flags and one example.
- [`docs/features/csv-view.md`](features/csv-view.md) — open a `.csv` or `.tsv` in the code view to read it as a table; `?all=1` draws more rows, `?view=source` shows the text. The terminal has its own table view for them (see the `.csv` paragraph above).
- [`docs/features/file-media.md`](features/file-media.md) — a file in the browser: every file page has **Raw** and **Download** (any size), and `/:owner/:name/media/:ref/*path` serves images, audio, video and PDFs under their real type, sandboxed, with byte ranges.
- [`docs/features/config-form.md`](features/config-form.md) — a JSON file opens as a form: typed fields (from its schema when one is found), cards to add and reorder, and a save that commits for a writer or proposes a pull for anyone else. In the terminal, a reader edits in the workspace (`e`) and `c` proposes the change from their fork; any commit there that breaks a JSON file's schema is refused first.
- [`docs/features/release-later.md`](features/release-later.md) — owner-run `scripts/release-later.ts`: list and unlink the issues the old Later-gate rule still holds.
- [`docs/ROLES.md`](ROLES.md) — guest, member and admin, and what each may do.
- [`docs/MCP.md`](MCP.md) — the forge as a connector; [`docs/STANDARDS.md`](STANDARDS.md) is what it answers by default: `.well-known`, feeds, cards, the manifest.

**Apps and the crew**

- [`docs/APPS.md`](APPS.md) — the contract for apps, previews and runs: making an app, the vocabulary, and the rules that are mechanical rather than advisory.
- [`docs/ADAPTERS.md`](ADAPTERS.md): the contract for an adapter app, its `adapter` block, `POST /pull` and its answer, and what the forge does with a bad answer.
- [`docs/CONTRACT.md`](CONTRACT.md) — who may do what, as a table: an app's `contract.json`, the one evaluator every app decides with, the audit that reads it from git, the probe that knocks on the running app, and the wall a person alone crosses.
- [`docs/WEBSPEC-PREVIEWS.md`](WEBSPEC-PREVIEWS.md) — the website specification run over every preview, report-only.
- [`docs/CREW.md`](CREW.md) — the crew: agents, how a run works, review, live triage, the merge queue, spend, roles and invites, the sandbox, passports, and the direction a vision pull will write.
- [`docs/SENTINEL.md`](SENTINEL.md) — the forge hunting its own faults; [`docs/HUNT.md`](HUNT.md) is the bug hunters' detectors against one running app (`bun scripts/hunt.ts <origin>`).
- The `flow` label: ready issues labelled `flow` go first (`readyNow` in `src/core/dependencies.ts` is the one place); when none is ready, builders take other ready work as usual. There is no switch and no state. A writer puts an issue first with the **Flow first** button on the issue and on each row of its list (`POST …/issues/:number/flow`), with `f` on the terminal issue screen, or with MCP `labels` and `action: "add"` (all three make the label on first use, for a writer only); the map's "Ready now" shows labelled work on top, marked `flow`.
- Outsiders directing the crew: the terminal's About card (`I`) has a Crew row saying whether people who cannot write may direct the crew (the web page's words). A repository admin who is a person presses `d` to see the plan, then enter to confirm (esc changes nothing); it calls `setCrewOutsiders`, as MCP `outsiders` does. The key is `d`, not `o`, because `o` is the fork's upstream offer on the same card and `d` never clashes with it; a writer who is not an admin and an agent are not offered `d`.
- Visibility at the terminal: on the About card (`I`) a repository admin who is a person sees `V make private` on a public repository and `V make public` on a private one. `V` opens a confirm that names who will see it (public: anyone with the link, signed in or not; private: only its members and the crew, while forks and clones already made keep what they have), with Cancel selected first, so enter alone changes nothing. Confirming calls `updateRepoSettings`, as the web About form and MCP do, and toasts `now public`, `now private` or the refusal (a sealed report stays private until it merges). A writer who is not an admin and an agent are not offered `V`; an agent that administers its own repository changes visibility on the web or through MCP, not here.
- Description at the terminal: on the About card (`I`) a repository admin who is a person sees `w write description`. `w` opens a one-line prompt filled with the current description; enter saves it through `updateRepoSettings` (as the web form and MCP `repo_settings` do, so it is audited the same way) and toasts `description saved`, esc changes nothing, and an empty line clears it. Control characters and more than 2000 characters are refused in a toast and nothing is written. That cap and the control-character rule live in the terminal only: the web form and the API accept any text. A reader and an agent are not offered `w`, and pressing it does nothing.
- Default branch at the terminal: on the About card (`I`) a repository admin who is a person sees `b default branch`; a writer who is not an admin and an agent are not offered it, and pressing it does nothing. `b` opens a picker of the repository's branches with the current default marked `default`; enter on another branch asks `make <branch> the default? y/n` with Cancel selected first, so enter alone changes nothing, and `n` or esc leaves it. `y` saves through `updateRepoSettings` (git HEAD moves first, audited as from Settings), toasts `<branch> is the default branch`, and the card's row shows it. If the branch vanished meanwhile the toast says `<branch> is no longer a branch here` and nothing changes.
- Prompt source at the terminal: `i` on the Deploys screen opens the app's Instagram prompt source, as Settings › Prompts does, and is offered only to the repository's admin who is a person (an agent, a reader or a guest sees no `i` and it does nothing). It lists the account, when it last ran and what it said, and when the token is refreshed again. `a` connects one (the token typed masked, then the hour in UTC; it is never drawn or logged), `f` fetches now and says what came back, `d` removes it after a `y/n` confirm. A second `f` while a fetch is running is ignored. Refusals are the page's words (`invalid_token`, `invalid_at`, `no_such_source`, `not_running`, and `already_connected` only when an account was connected on the web while the screen was open: the screen offers `a` only when there is none).
- Stop running as an app at the terminal: `X` on the Deploys screen, offered only to the repository's admin who is a person while it is an app (a writer who is not an admin, an agent, a reader or a guest sees no `X` and it does nothing). It asks you to type `<owner>/<name>`; anything else says `Type <owner>/<name> to confirm.` and changes nothing. The exact name calls `disableApp`, as Settings' Stop running as an app does: production and every preview stop and their data and checkouts are removed, the code is untouched. It toasts `no longer an app` or the refusal, and the screen re-reads and says the repository is no longer an app.
- Everyday account at the terminal: a forge admin with no choice made sees a muted line at the head of the dashboard asking, as the web home card does. `E` opens Settings on the web to make the everyday account (it is made with a passkey, which the terminal cannot hold); `K` keeps admin, and the web stops asking too. Once linked, the line names the everyday account. Anyone else, and an agent, sees neither key.
- Events at the terminal: `v` on the About card (`I`) lists the repository's events newest first, 50 at a time; `n` loads the next page, `t` keeps only the kind of the row under the cursor (and again lifts it), `s` keeps only settings changes (the same `kind=repo.settings_updated` filter) and shows each as who changed what, from what to what (`alice changed repository settings: requireReview false → true`), `esc` goes back; it reads once on opening and does not refresh while open. The audience is `GET …/events`'s and MCP `events`' (a webhook's URL and an app's variable names are the admins').
- Crew at the terminal: `C` on the About card (`I`) lists the repository's crew with their roles (`j`/`k` to move), as Settings → Crew reads it. Only an admin who is a person is offered `a` (asks for an agent's name) and `d` (takes the selected agent off); each asks a confirm first. Both go through `addToCrew`/`removeFromCrew`, and refusals are worded by `crewRefusal` (`src/actions/crew_words.ts`), as Settings → Crew flashes them. Everyone else sees the list and no write key.
- Why it is not moving: MCP `flow` with `{ repo }`, `{ repo, issue }` or `{ repo, pull }` (a writer's) answers the first gate that holds it (`ceiling`, `hot_file`, `blocked_by`, `later_gate`, `no_builder`, `no_headroom`, `red_check`, `waiting_review`) with the action that clears it, or `state: closed`/`merged` when nothing is left to move; a pull is read against the head git has now. The terminal's About card (`I`) carries the repository's answer in a **Moving** row for a writer (`src/flow/why.ts`).
- [`docs/FLOW.md`](FLOW.md) — where every issue stands: `GET /api/v1/repos/:owner/:name/flow` returns each open issue's stage, since, stalled and unblock, plus what went live in the last 24 h.
- A ready issue held on a hot file names the open pulls on that file, oldest first, at most 8: `held.pulls` in `GET …/map` and the MCP `map` tool, links after the sentence in the flow panel's "Ready, and why it waits" card, and `#N` lines in the terminal Flow dialog. Read from the pull files the picker caches (`src/crew/hot_files.ts`), per reader: a sealed pull is named and counted for the owner only.
- Flow reads: `bun scripts/flow-report.ts [--db <path>] [--public] [--json]` prints one line per read; see [`docs/FLOW.md`](FLOW.md).
- Under it, the panel says the crew's build yield over 24 h (runs finished, pushed, landed; `src/flow/build_yield.ts`) and the median hours to first review (`src/flow/review_latency.ts`); the terminal Flow dialog carries both in the same words (an agent reader there sees public repositories alone). `/boards` is for admins alone (anyone else gets not-found), so the page shows all repositories.
- The flow panel on `/boards` also says the time to land (median and slowest of the last 24 h, `src/flow/lead_time.ts`) and who opened the last hour's pulls (names linked, `src/flow/openers.ts`); non-admins read public repositories alone. The terminal Flow dialog carries the same two facts in its own words.
- The flow panel's Hot files card and the terminal Flow dialog also name files that gained open pulls over the last hour ("warming: src/a.ts 2 → 4 pulls", at most 5; `src/flow/hot_trend.ts`). The hour-old counts are samples kept in memory by `src/crew/hot_history.ts`, so after a restart nothing is named until a half-hour-old sample exists; an agent sees public repositories only. The MCP `flow` tool does not carry it yet.
- Under each queued repository's merge-queue line, the terminal Flow dialog lists its last five gates, newest first: the pulls carried, `green`, `red` or `cut off`, how long ago, and for a red gate the first failing test with its file, `flaky` when two gates sharing no pull failed it (`src/checks/gate_result.ts`, as MCP `queue_gates` reads them); a repository with none kept says `no gates yet`, and an agent reader sees public repositories only.
- The flow panel on `/boards` has a Last gates card: the newest ten merge-queue gates, each with its pulls linked, green, red or cut off, and the first failing test with its first error line (or the reason a gate was cut off). A gate carrying a sealed pull shows `a sealed pull` and the verdict alone; a non-admin reader sees public repositories only (`src/web/pages/boards-gates.ts`, the same `recentGates` read as MCP `queue_gates`).
- The flow panel on `/boards` and the terminal Flow dialog say how the open crew pulls sort into piles (red, conflicted, changes asked, approved and waiting, awaiting review), each pull counted once in the first pile it fits (`src/flow/pile.ts`).
- On the terminal's Asked screen, Enter on a thought opens a card of what became of it, as MCP `thought` answers: the issue it placed (Enter opens it), "kept as a note" or "not placed yet", and the thoughts it repeats or takes back and the later ones that did the same to it. A repository you cannot read is named as nothing, and a thought that is not yours or is gone says "No such thought". The card is a snapshot; `r` re-reads it (`src/tui/screens/asked.ts`).
- The off-box snapshot mirror is set from three doors with one set of rules (`src/actions/mirror.ts`): Settings → Backups, MCP `mirror_set` (`set` or `forget`), and the terminal's Resilience screen (a forge admin who is a person; an admin agent only reads). The screen shows `Mirror: <place>` or `Mirror: none.`, `m` seals it with five prompts (endpoint, bucket, region, access key, secret key; the keys are masked as typed) where a blank keeps what was sealed, and `f` forgets it after a confirm. `t` tests where snapshots go, as MCP `backups_test` and the Backups page's Test button do: the sealed destination, otherwise the environment's, said as `Reached …: N objects listed.` or `Could not list …: <reason>` in the page's words; with none set it says so and calls nobody. A key is never read back or drawn.
- [`docs/PLANNING.md`](PLANNING.md) — how issues depend on issues: the edge, the map, and what "ready now" means to a person and to the crew.
- [`docs/FLEET.md`](FLEET.md) — one change across many repositories, runs or issues: a query, a dry-run plan of every row before → after, a receipt, and undo.
- [`docs/HOME-EVAL.md`](HOME-EVAL.md) — scoring the owner's home with a reader who has no context.
- [`docs/PROFIT.md`](PROFIT.md) — the profit slider: cost against responsiveness.

**Other forges, and the forges this one spawns**

- [`docs/ORIGINS.md`](ORIGINS.md) — one workbench over GitHub, Forgejo and Gitea: connecting, mirroring, writing through, migrating, and following an outside branch.
- [`docs/SPAWN.md`](SPAWN.md) — a forge births a forge: the claim link, the family, sizes and the child quota.
- [`docs/FOLLOWING.md`](FOLLOWING.md) — a fork that keeps up with its parent: where it stands, taking updates, the crew's part when both sides moved, and ranked forks.

**Running it**

- [`docs/OPERATING.md`](OPERATING.md) — configuration, health, how a release proves itself, flags, limits, check tiers, fuzz and chaos, and writing a database guard.
- [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) — the principles and the reasoning behind the shape above.
- [`docs/CACHING.md`](CACHING.md) — what the forge keeps between requests to make `/map` and `/` fast: each map lane's plan and each viewer's feed candidates, stamped with SQLite's own write clock so any write is seen on the next read, keyed so one person's view never reaches another, and the budgets `test/snappy.test.ts` holds. `bun run bench/snappy.ts` prints p50/p95 and SQL statements per request for both pages, warm and cold. The content-addressed assets answer a revalidation with `304`.
- [`docs/METRICS.md`](METRICS.md) — `GET /metrics` for Prometheus.
- [`docs/THREATS.md`](THREATS.md) — who would attack the forge, what each wants, and the test behind every protection (`/resilience` reads it).
- [`docs/DOMAINS.md`](DOMAINS.md) — the ways the forge stops, and what it says when each does.
- [`docs/SNAPSHOT.md`](SNAPSHOT.md) — a forge back from a copy: what a nightly snapshot holds, where it goes, the drill, and the one command that restores it.
- [`docs/RECOVERY.md`](RECOVERY.md) and [`docs/RESTORE.md`](RESTORE.md) — the forge back at 3 a.m., and on a fresh machine; print them.
- [`docs/CLOUD.md`](CLOUD.md) — clouds are capacity, never dependency, and the cloud accounts an admin keeps.
- [`docs/CLUSTER.md`](CLUSTER.md) — the check lane as Kubernetes Jobs.
- [`docs/EXTRACT.md`](EXTRACT.md) — the forge on a machine of its own, and the platform it grew up in switched off: what a host owes it, the moves in order, and what is given up.
- [`docs/PLATFORM.md`](PLATFORM.md) — everything the forge still takes from open-platform, what replaces each, what is done, and the issue for the next step; the order and the gate for switching the platform off.
- [`docs/ops/ROLL.md`](ops/ROLL.md) — rolling a release.

**Design and records**

- [`docs/DESIGN.md`](DESIGN.md) — the design system's spine; its sections are under `docs/design/sections/`.
- [`docs/SPIKE-CLOUDFLARE.md`](SPIKE-CLOUDFLARE.md), [`docs/AUDIT-MANY-HANDS.md`](AUDIT-MANY-HANDS.md), [`docs/BACKLOG.md`](BACKLOG.md) and [`docs/research/`](research/) — a spike, an audit, a backlog and research notes, kept as written.

What the crew's tokens bought is on the board (`/board/returns`), in MCP `returns`, and in the terminal: the palette's Usage carries a Returns line (dollars, runs, changes landed, cost per landed change; `[`/`]` move between 1, 7, 30 and 90 days), and Usage of a repository (`owner/name`) narrows it to one app. On the forge-wide Usage, `f` opens the fleet graph (what `/fleet/graph` shows): one sparkline row per repository for runs and for spend, each with its total at the right, over 24 h by hour or 14 d by day (`w` toggles); past eight series the smallest share "N others", and a short terminal ends with a "+N more rows" line. Who may see spend is the action's rule (`src/actions/fleet-graph.ts`), not the screen's. The palette's Forge spend is the forge-wide spend (`GET /api/v1/usage`, MCP `usage` without a repo): today and the last 24 hours, and each subscription's headroom, for the apps you write (an admin sees all; a guest, nothing). Owner facts only (`src/actions/returns.ts`); see [`docs/OPERATING.md`](OPERATING.md).

The terminal's palette has `Signed in` for anyone signed in: your browsers, tokens and this terminal's key, with when each was last seen; `d` signs the selected browser out after a confirm, as `/settings` and MCP `sessions` do, and on a token revokes it after a confirm (Keep is the default) through the same `deleteToken` action as Settings and the API, so it stops working at once (`docs/CREW.md`, "Where you are signed in"). `p` there changes your password: it asks the current one, the new one and the new one again, each masked and never echoed, and changes it through `changePassword`, the action behind Settings, so a wrong current password, a throttled account, a new one under 10 characters or over the cap is refused in Settings' words (the length is refused at the new-password prompt, before the confirm); an agent signs in with a key and is not offered `p`.

The release keeper (`src/keeper/`, #7557) cuts, promotes and verifies releases on the forge's own one-minute timer, with no model. It is off until `FORGE_RELEASE_KEEPER=on`, and the pod's service account may `get` and `patch` the forge Deployment. `FORGE_RELEASE_KEEPER=swap` needs no cluster: it swaps main's tree in place (`docs/features/ship-itself.md`). Its tag is the forge's own and is not pushed to an origin, so a cut is invisible to Forgejo-side tools. /releases, the terminal's Release keeper and MCP `release_keeper` show each release's short commit and its seconds from landed to live; /changelog's live line says it too.

- **Cut:** it tags main's head as `v<patch + 1>` when main has moved past a live tag, nothing is in flight, the merge queue is still, 30 minutes have passed since its last cut and no hold stands.
- **Verify:** it records the known-good version and image before the tag, sets the Deployment's image, and has the new version spend ten minutes under page load probing `/healthz` each second.
- **Roll back and hold:** three bad probes in a row hold further cuts with the numbers and set the recorded known-good image back by name, never "undo". A pull saying `release hold <N>` lets the fix through, and that release verifying lifts the hold.
- **Owner's hold:** set and lifted from the card, the terminal (`h`) or MCP `release_hold`, by a person who may roll back, never an agent.
- **Where to see it:** the **Release keeper** card on `/releases`, `Release keeper` in the terminal's palette, the **Maintenance** board under `/boards`, MCP `release_keeper` and `GET /api/v1/keeper` (JSON; 403 for a caller who may not read releases), each gated as `/releases` is: a guest sees none of it.

How it works and how to turn it on: [`docs/features/release-keeper.md`](features/release-keeper.md).

`/changelog` lists the last 30 releases of `FORGE_REPO` (public only) with their pulls, for anyone; the terminal's palette has `Changelog` for the same list. In the terminal, `/` takes a word and keeps the releases whose version or pull titles contain it (`esc` clears it); Enter on a release lists its pulls, and Enter on a pull opens it (`docs/features/changelog.md`).

A wave's page and the terminal's wave screen both list **Moved**: the milestones above the issues the wave's merged pulls closed, each with how far along it is now (`2 of 3 done`) and a link or path to open it. One function, `movedForViewer` (`src/story/wave_moved.ts`), computes it for both, over the milestones page's cached plan, and leaves out any milestone the viewer may not see; a wave that closed nothing under a milestone shows no Moved block.

The web changelog's days and its "shipped today" count follow the reader's clock: a small script regroups the server-rendered cards into the browser's own days (Today, Yesterday, then a date) at load and after each live swap. With no script the days are UTC and the page says UTC. The script runs at `DOMContentLoaded`, before the first paint of this small page, and rebuilds the cards from the first one, so only the UTC mark leaves; that shift is accepted. `happy-dom` is a dev dependency, used only by the test that runs this script against a DOM.

A repository admin cuts a wave from two doors, both through `cutWaveFor` (`src/actions/cut_wave.ts`): Settings → *Cut a wave*, and `c` on the terminal's waves screen, which says how many pulls would go in, asks `cut wave N? y/n` (`y` and `n` choose outright) and shows the draft pull's number (Enter opens it). Each opens a draft pull listing the pulls merged since the last wave; nothing merged, an earlier wave that does not parse, or a viewer who is not an admin is refused in the action's words, writing nothing.

Cmd-K finds a repository by its name first (exact, then prefix; your own ahead); a repository with an app has an "Open the app of …" option under it, and Cmd/Ctrl+Enter on the repository opens the app (`docs/features/cmd-k-repositories.md`).

In the terminal, the palette's **Your profile** (any signed-in person, never an agent; a guest is not offered it) shows username, display name and email; `n` sets the display name and `e` the email through `updateProfile`, the action behind Settings → Account. Refusals read as the page's do (`src/actions/profile_words.ts`, including one shared fallback for a refusal with no words of its own), and a changed email says a confirmation link was sent to it and that it is unverified until followed.
