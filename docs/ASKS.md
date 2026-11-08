# Asks

What waits on a person, and how to answer it without opening each thing: `/asks`, the terminal's On you card, `GET /api/v1/asks` and the MCP `asks` tool. The board's own notes are in `docs/TOUR.md`.

**What an ask row waits for.** Every ask row carries one word, `waitingFor` (`src/core/waiting_for.ts`, computed once), and who it waits on, e.g. "ready to land · on you". The first that applies wins: `conflicts with main` (the last sweep found files stopping the pull, on its author), `ready to land` (a green change to look at and ship), `a review` (a review or a hand-over), `assigned to you` (the pull or issue is assigned to the viewer), otherwise `a decision`. It shows as a chip on each row of `/asks`, as `waitingFor: {word, on}` in `GET /api/v1/asks` and the MCP `asks` tool, and in the terminal's On you card. A grouped row shares one word (the weightiest of its items), and the terminal's card shows its row's word.

**Waiting.** A pull waits on a person when the crew handed it over, or when no person has acted on it for 24 hours (`WAIT_LIMIT_MS`, `src/core/pull_wait.ts`): a person's opening, comment or review restarts the clock, the crew's own words do not. The row is "Waiting" with how long (`waiting 30 hours`); it is on `/asks`, `GET /api/v1/asks` (`kind: "waiting"`, `why`), MCP `asks`, and in the terminal's On you card (`waiting` before the title). A pull you hold never asks for being idle, and a crew pull still at work or younger than a day stays the crew's. It can be picked, shipped or closed with the other rows (`waiting:<id>`). A crew member can advise by ending a comment with one line, `Recommendation: merge|close|change — why`; the newest such line from a non-person is shown as "The crew advises: merge — why" on the page and the terminal row, and as `recommendation: {verdict, reason}` in the API, on handed-over rows too.

**Muting a repository from /asks**: each ask row on `/asks` carries a "Mute owner/name" chip. A muted repository's asks leave `/asks`, `/api/v1/asks` and the phone's pushes (the same per-user mute the On you card uses, no new table); `/asks` says "N muted repositories still ask" with a "Listen again" button, and an app's own page still counts them. The home itself renders no asks, no for-you list and no count: the top bar carries a plain Asks link to `/asks`, and the terminal's dashboard keeps its On you card on purpose (a different door).

**A wave proposal is one card.** With "plans need a nod" on, a plan the planner writes is kept as a proposal and opens nothing. It is one row in the asks list (`/asks`, `/api/v1/asks`, MCP `asks`, the terminal's On you card) with its title, its why and its issue titles, all escaped, and it asks the app's owner only. Three taps, each one POST that leaves you on the page you were on: **Approve** opens the issues with their links, exactly as an unheld plan would; **Redirect** takes a text box and hands your words to the planner as a new run on the direction issue; **Later** hides it until you bring it back, from the "N waves put aside" line under the asks on `/asks` (each with a "Bring back" button). A proposal is decided once. The same four verbs (`approve`, `redirect`, `later`, `again`) are on every door, all calling `actions/proposals.ts`: the page (`/asks/proposal/<id>/<verb>`), the API (`POST /api/v1/asks/proposal/<id>/<verb>`, a `rw` token, `{"words": …}` for redirect), the MCP tool `asks_proposal` (`id`, `verb`, `words`), and in the terminal `y` approve, `R` redirect, `l` later and `B` bring every put-aside wave back, on a wave row of the On you card.

**Chips on the feed**: kind chips switch a kind of post off: `reviews` (pulls), `decisions` (decisions and choose decks), `crew` (tells, replies, looks) and `releases`; a person chip switches one person or agent off. Saved per user, one filter (`chipHides`) behind the home feed, `/api/v1/feed`, the Asks list and the terminal's inbox, and the MCP `feed` and `asks` tools, which also take `hide_kinds` and `hide_people` to replace the saved filter for that one call (`[]` lifts it). `/live/apps` (your apps) is not feed items, so chips do not apply there. `GET /api/v1/feed/chips` answers `{kinds, people}`; `POST /api/v1/feed/chips` takes `{"kind": "kind"|"person", "value": "reviews"|"<username>", "hidden": true|false}` (scope `rw`, same-origin). In the terminal dashboard `1`–`4` switch the kind chips `h` on an On you row switches its author off (not your own) and the author's rows leave the card, and `P` brings every person back. The `feed_chips` tool reads them (no arguments, any token) and switches one (`kind`, `value`, `hidden`; an `rw` token).

**On you, in the terminal**, answers to the same mutes and one-move verbs as
the web card. Repositories you muted are hidden and counted ("2 repositories
muted"). On the On you card: `space` marks a row, `x` closes the marked rows
(or the row under the cursor) with one reason, `m` mutes their repositories,
`S` ships them, `u` undoes the latest set within its day, and `L` listens
again to every muted repository. Each goes through `applyAsksBulk`, so the
per-row access checks and refusals are the web's, shown in the toast.

**What the decider did today.** Today's card on the board carries one line,
"The decider closed N, deferred N, asked you about N": each count links to
its ledger rows (`/board?ledger=closed|deferred|asked`; any other value is
ignored, `?apps=` is kept). A deferral is the decider's own `stop`, never the
rule's. The ledger view lists up to 200 rows and says when it left some out.
In the terminal the same line sits above the dashboard, `C` (or the palette's
Decider) opens the rows, and `1`, `2`, `3` switch pile. Under the line, one
muted line per app that ran or shipped this week says what one shipped change
cost, in the board's words ("$3.00 per shipped change this week"); at most
three, then `+N more apps`. Both are for the repositories you own only: a
reader sees nothing.

**Give back to the crew** is on a pull a pass gave up on and assigned to you
(finishing, requested, sweep, picker): its row says the pass's reason in one
line, and one press assigns the pull to the builder that last worked on it.
`POST /api/v1/asks/give-back` (`{"item": "assigned:<id>"}`), or the MCP tool
`asks_decide` with `give_back: true`. In the terminal the On you row says
`handed to you: <reason>` and `b` gives it back (the same `b` as on a
handed-over card). Only a note posted under your own name counts as the
pass's: a copy of its first words by anyone else shows nothing.

**Let the decider** answers a hand-over card (an issue the crew parked) when
you would rather not: the third tap on the card, `POST /api/v1/asks/decide`
(`{"item": "parked:<id>"}`), the MCP tool `asks_decide`, or `D` on the On you
card in the terminal. It sees only the direction text, whether you pinned or
muted the app, the day's spend against the ceiling, your last ten decisions
there and the card's own evidence; the decision ledger row carries exactly
that, with a reason and a confidence. A sure answer (70% or more) to set it
aside takes the card off your board; an unsure one, a failure, or no decider
configured leaves it with you. Undo for a day (`/api/v1/asks/decide/<id>/undo`,
`asks_undecide`, `U`). Each tap is a paid call, so one card is handed over
once in ten minutes.

**The standing rule** says who answers a repository's hand-overs without a
tap, three ways: `me` (the default: they wait for you), `decider` (the sweep
asks the decider about each parked card and its word stands, whatever its
confidence), or `decider_tell` (the decider's sure set-asides, 70% or more,
take the card off your board; the unsure ones stay with you). The tap on the
card follows the same rule. A shelved repository, one whose autonomy is `off`,
has its parked cards closed by rule with no model call whenever the rule is
not `me`, so turning the crew off on a ruled repository closes what it had
parked. The sweep spends at most five model calls a tick and never re-asks a
card already answered or undone. Only a repository admin who is a person sets
it, never an agent. Set it in the repository's settings (Autonomy → Decisions
here); over the API with `PATCH /api/v1/repos/<owner>/<name>`
`{"decisionsBy": "me" | "decider" | "decider_tell"}` (admin token; it is in the
repository JSON too); over MCP with `decisions_by` (`repo`; without `by` it
says how the rule is set, with `by` it plans unless `dryRun: false`); in the
terminal with `R` in the repository's workspace, which cycles me → decider →
decider_tell.
