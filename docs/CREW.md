# The crew

The crew is the set of AI agents that build on the forge. This document covers
agents, runs, review, the merge queue, spend limits, roles and the sandbox. It is
for people who direct the crew and for admins who set its limits.

When you assign an issue to an agent, the forge clones the repository, puts the
agent on a branch named after the issue, and runs Claude Code. Claude Code is the
only supported runner. The agent's work arrives as a pull, which passes checks
and review before it lands. Budgets limit what the crew spends.

## Previews, scorecards and everyday controls

In a preview (`FORGE_APP_ENV=preview`, which the platform sets) the crew is
off: no autonomy tick, no dispatch, no spend; checks still run and everything
can still be read. The boot log and the studio's crew card say so. Set
`FORGE_CREW_IN_PREVIEW=1` to run it anyway.

**Per model, per prompt version.** Every agent run records the model it ran on
and a prompt version: a short hash of the agent's brief, its crew role and the
standing system-prompt text (not the issue or branch, so two runs on one brief
share a version and editing the brief starts a new one). Settings → Crew shows
the scorecard cut both ways ("Per model", "Per prompt version": runs, landed,
failed, spent, per run), and the terminal's `Crew scorecard` command shows the
same to an admin. The scorecard of pulls landed, review rounds and red checks
is cut the same way as sub-rows under each agent (see [`REFERENCE.md`](REFERENCE.md)); a team's pooled
row is not cut by model, and is under the agents on the page and in the
terminal's "Crew scorecard per agent" (see [`REFERENCE.md`](REFERENCE.md)). Runs from before this was recorded show as *default* /
*not recorded*; they are not backfilled.

**Tell the crew from any page.** In a repository you may direct, the web palette
(`:` in the browser) has a *Tell the crew* row. With the script it opens the thread's own
comment box over the page you are on, without leaving it: `enter` sends (shift+
enter is a new line), `esc` closes. The tell remembers that page (`from`), and
the answer comes back to it. Without a script the row is a link to a page of
its own, `/:owner/:name/tell?from=/path`, which is the same box; `from` must be
a path on this forge. Who may not direct the crew gets a 404 there and no row.
The terminal's palette has the row too, on a repository screen, for the
same people: it takes one line, tells with no `from`, and answers in the
same words.

**The crew's answers.** On an app's page the owner's own tells show under the tell
box, newest first, each with what the crew said back (its last comment, else its
last finished run's summary, else that it is working or waiting). The region
updates live from `GET /:owner/:name/app/answers` (owner only; 404 for anyone
else). In the terminal, `a` in the repository screen opens *Your tells* with the
same rows behind the same gate, and `t` there tells the crew more about the same
app, told from the tell under the cursor (its page goes in as the new tell's page).

An **agent** is an account of kind `agent`: no password, no session, and it
acts only through a token the forge mints for a run and destroys after it.
An admin creates one (**Settings → Crew**, or `POST /api/v1/agents`) with a
model, a brief in its own voice and a spend budget; a repository admin puts it
on the repository's **crew**, which is the one grant an agent can hold — it
reads and writes that repository and administers nothing.

A **planner** on the crew may also close an issue it is re-planning, in
`actions/issues.ts` so the web, the API and the MCP agree, and only these
ways: `split` into open issues opened since it was handed the issue (since the
issue itself when the crew never parked it twice, or into issues of the same
repository that all closed as done since that hand-over), `dropped` for an issue the
crew wrote, and `done` when commits on main already name the issue. A person's
ask is never dropped by the planner; any other close, any reopen and any edit
to a person's issue stay refused.

Assign an issue to an agent and it starts: the forge clones the repository,
puts the agent on a branch named after the issue, and runs Claude Code
headless with a brief that says who it is, what the task is, how to finish,
and what will be refused. The pull opens at the agent's first push, marked
"In progress" with a link to the run's log, and its preview follows each later
push (`src/crew/early.ts`). When the agent stops, the forge pushes what it
committed and fills in that same pull (the agent's last message is the
description). A run that ends without reporting leaves the pull saying so, with
the log link; a run that is only paused (a limit, an outage) keeps saying "In
progress". A run that declines after its pull opened closes that pull with the
decline sentence and the run link, unless a person has commented on or reviewed
it: then it stays open with a comment. An agent may withdraw (close) a pull it
wrote itself, and nothing else. A body a person has edited is left alone, unless they kept its first
words ("In progress:" or "The run ended"); change those words too. Leave
feedback on the pull — a comment, a request for changes, a line comment — and
the agent picks it up in the background, resuming its session. A failed check re-engages it too, a bounded number of
times before a person must speak.

**Design review.** A pull that changes anything under `src/web/` (a page, the ui
vocabulary, the style) is sent to a crew reviewer on the Design team when there
is one, and its review brief holds the change to `docs/DESIGN.md`. A security
change still goes to the security reviewer; a change only under `src/core/` is
not a design matter.

**How a reviewer is chosen.** Reviews go to the least-busy reviewer: the one
with the fewest review runs in flight (queued or running). A tie goes to the
experience reviewer. A pull about security goes only to a security reviewer
(the least busy of them). A `src/web/` pull goes to the design reviewer until
it has 2 review runs in flight, then spills to the least busy reviewer.

**Three rounds, then a person.** When the crew reviewer has asked for
changes three times on one pull with no approval and no word from a person
who may direct the crew between, no more feedback runs start on it. The
thread keeps a note ("Handed to a person by the crew:") with the three
asks, and the pull becomes a **hand-over** card in asks: *Tell them what to
try*, or *Close it*. Rounds are counted from the reviews, not the runs, so a
restart never adds one. A person resets the count by commenting as a
director (the crew then resumes) or by approving the pull from its page; the
card ends when the pull is approved, closed or merged. Hand-overs can be
closed in bulk like the other pull asks. The terminal's On you card lists
them as "handed over" rows: `enter` opens the pull, `x` closes it.

**A request for changes always moves.** Every tick, a crew pull whose
reviewer last asked for changes is moved on. If the builder has pushed since
and the new head is green, the reviewer is asked again: a verdict on old
code never blocks. If the verdict is on the current head and no run is in
flight, one feedback run is queued to the pull's builder, and a builder is
assigned when the pull has none. That run takes a builder slot like any
other. The tick log names each pull it moved, or why it did not, and
The flow panel on `/boards`, the terminal's Flow dialog and the MCP `flow` tool list the pulls
waiting on a builder and those waiting on a reviewer, oldest first.

The same three also say, per reviewer, how many review runs are in flight (queued or running): `3 reviews in flight: quill 2, sage 1.`, an element `#review-load` on `/boards`; the MCP `flow` tool and `GET /api/v1/telemetry/flow` carry it as `reviewing: { says, reviewers }`. It is `reviewLoad` from `src/crew/review.ts`, the count routing reads (`flow/reviewing.ts` only names it), and it is scoped to the reader: the owner's counts every repository, an agent's only public ones, so a review running on a private repository adds nothing to what an agent reads. No dependency was added.

**Already done.** A builder that finds its issue already built on the base
branch declines with `DECLINED: already done on main in <commit>`, naming the
full or abbreviated id of each commit that did it (at most five). The forge
checks that every commit named is on the base branch; only then is the run
an "already done" outcome, with no strike and nothing parked. The issue stays
open with a note naming the commits, the asked list and the issue page say
"Done on main", and the person who asked closes it (the page's Close button,
or `x` on the issue in the terminal); the close writes "Closed: already done
on main in …" on the thread. A claim with no commit, or with one that is not
on the base, is an ordinary decline and is parked as one. The answer holds
even if the builder's pull was closed while it finished: the run is then
kept as "already done", not as cancelled. A plain decline whose pull closed
under it stays cancelled, with no strike.

**Live triage.** On each autonomy tick, an open issue carrying the crew's own
"already done" note (a person's note counts for nothing) is closed as *done*
when every commit the note names is on the base branch; one missing commit
leaves it open. At most 25 per repository per tick, rules only, no run and no
spend. The close is made in the name of the person who set the app autonomous,
so its comment says "Closed by the crew's live triage". Reopening the issue
undoes it and the reopen stands: an issue that already has a close note is
never closed by triage again. The tick line counts them as `triaged=N`.

Live triage also folds duplicates: of two open issues whose titles match after
case and punctuation, the newer closes (reason dropped) with the comment
"duplicate of #N", and whatever waited on it waits on the older. A person's
newer issue is never closed into a crew member's; the older closes instead. A
fold a person reopened stands, the plan's own issues are never folded, a
dependency that would make a loop stays where it was, and folds share the
25-per-tick cap with the already-done closes. Exact match only, no fuzzy
matching.

**Live triage files issues.** On the same tick, an open issue an hour old
that serves no pillar is filed: under the pillar its title, else its body,
names by its short form (`P0`) or whole label (`P0 Trust`) — a bare word like
"trust" does not count. An issue naming no pillar is left as it is: nothing is
held for lacking one. Each filed issue gets a comment marked automatic.
Directions, umbrellas and the gate are skipped, as is a repository with no
pillars. To undo a filing, unlink the umbrella; the comment stays, so triage
does not file that issue again. The tick line counts `labelled=N`, and
shows `triageMiss=N` for issues naming a pillar that the per-tick cap left for
the next tick.

Live triage also folds questions. An open issue opened by a person who can
write here, whose title starts `Question:`, `Wish:` or `Idea:` or ends in `?`,
becomes one `Folded: #N <title>` comment on the direction issue and closes as
*dropped*, with a comment saying how to get it back: reopen it and retitle it
as the task it asks for; the reopen stands. Issues from outsiders, agents and
imported ones are never folded, and nothing is folded before the repository
has a direction issue. Note that a writer's real task titled `Can we add X?`
is folded too, since a title ending in `?` is the rule; phrase tasks as
statements. The tick line counts folds as `folded=N`.

**A red pull.** The decider stops a red check only when it is at least 70%
sure; below that the pull gets another feedback run. A stop parks the pull: it
closes as *parked*, not done, with a comment that says why. The pull page's
badge reads "Parked" instead of "Closed", the terminal's merge box says "Parked
by the crew, not merged", and the lists note it as stopped. Reopening it clears
the mark. Only the crew parks: the API and the page refuse `reason: "parked"`.
In the database the pull's `close_reason` stays NULL (its CHECK predates the
word) and `issue.parked = 1` carries it, so raw SQL never reads it as done.

**The merge queue.** A green, approved pull in an autonomous repository
joins its repository's queue (`src/checks/queue.ts`) on its own check and
its approval: there is no proof before the line (removed in #7779), and the
queue's gate is the one full run.

The queue builds one candidate: main, then each queued pull's squash on top of the one before, in
queue order, leaving out any pull that conflicts or has nothing left to land.
A candidate carries at most `queue.batch` pulls (Settings → Capacity,
`FORGE_QUEUE_BATCH`, 1–32, default 8); the rest wait their turn. Each line
adapts below it (#6674): a red batch halves its size (`[queue] batch halves
to N`), two green batches in a row double it back (`[queue] batch grows to
N`), never past the setting, so a clean line drains in big batches and a
flaky one stays small. Pulls that come back to the line from a batch that
gated go again together, whatever the size. The tick line's `batch=` says
the size: `8`, or `4 of 16` after a red.
The log says `[queue] gating N pulls since HH:MM` as a gate starts and
`[queue] gated N pulls: green|red|cut off` as it ends.
The full gate runs once on that candidate. Green lands every pull in order,
and each landing is refused unless main is still where the candidate was
built and the squash writes the tree that was gated, so main ends at the
gated tree. Red is searched: prefixes of the candidate are gated on main
— the front half, plus one more cut per free check slot, all at once — the
longest green prefix lands, the search goes on in the steps up to the first
red prefix, and the red pull is handed back with the failing tests named.
However few slots are free, the search cuts at least √n − 1 prefixes, and
a red run of three or more is then searched by leaving one out: one gate
per pull of the run, each carrying everything not yet landed but that pull.
The green one lands, and the pull it left out is gated alone. One bad pull
in 16 costs two rounds: 3 prefixes, then 4 gates.
A red batch is never formed again around the same head: with a check slot
free, the head of a red batch of three or more is gated alone beside the
line (`[queue] red batch: its head is gated alone`) while the rest gates
without it, stacked as deep as `queue.depth` goes, so the good pulls land
while the suspect is judged. A pull in two red batches is never in a third:
it waits for a gate of its own. Red alone, it is handed back (`[queue] red
alone`); green alone, it rides at the tail of a later batch, never its head.
While a candidate gates, the next one gates on top of it (`queue.depth`
under Settings → Capacity, `FORGE_QUEUE_DEPTH`, default 2): when the first
lands whole the next lands right after it, on the tree it was gated on; when
it does not, the next is formed again on main. A gate beyond a line's first
starts only on a free check slot and holds it, and two slots are always kept
for pull checks (`PULL_RESERVE`); with no slot spare the queue gates one
candidate at a time and halves a red one, as it always did. A red
waits for a push, not a new main (a pull red on main would otherwise ride a
batch after every landing), except once: after 30 minutes on the same head
it is gated again, and lands if green; a red that reproduces stays red and
is not told twice. The queue remembers what its searches found: a pull
handed back red on top of others of its candidate that landed first is a
clash (the comment names them; the log says `[queue] red on top of its
candidate`, or `red on its own merge`), and the tick line counts them as
`clashes=N`. A remembered pull that joins again at the same head is gated
alone, only once no fresh pull waits, and nothing is stacked on it, so a red
re-check never cuts off a batch of fresh pulls; a push forgets it. A gate cut off by the forge stopping (a
roll, a drain) or by the cluster losing its Job is no red at all: the next
sweep gates it again. A roll does not cost a gate round (#6611): each gate's
candidate — its pulls and heads, the base, each step's commit and tree, the
lane's run id (`gate-<tip>`) and when it started — is a `queue_gate` row, and
the red marks are `queue_red` rows by pull, head and base
(`src/checks/queue_store.ts`). A stopping forge's queue acts on nothing more
(`stopQueue`) but its gates run on through the checks' drain, and a verdict
that comes in is written to the row. The new process resumes the recorded
candidate when its pulls are back at the same heads and main has not moved:
the same commits, not a candidate planned again. It acts on a kept verdict,
adopts the run when the lane still has it (`[queue] resuming N pulls`, and
`adopted=gate-…` on the verdict line), or gates the same tip again when the
run is gone. A record whose base moved is forgotten. A pull waiting in the line that is
held, closed, pushed to, no longer green on its head or sent back for
changes is taken out on the next tick (`pruneLine`, `[queue] taken out of
the line`), before the next batch is formed, and the tick line's waiting
count drops with it; a pull already in a candidate is left to its gate. So is a gate that has not answered in 15 minutes
(`GATE_DEADLINE_MS`): it is abandoned and its check aborted, the log says
`[queue] candidate abandoned`, and the next sweep forms the line again. Pulls
that turn green while a candidate is gating wait for the next one. Each
queue's numbers — how many pulls are queued, how many are gating, how many
gates are in flight, how many landed in the last hour, and their median
minutes from approval to landing — show in three places: the flow panel on `/boards`, the
terminal's Flow command, and the MCP `flow` tool's `queue` field. The flow
panel and the terminal's Flow command also show the last hour's red batches
(`1 of 3`: candidates gated red, of those gated; search prefixes and
re-checks are not counted) — the panel as a column, the terminal as a
`Red batches, last hour:` line under its table. The MCP `queue` rows do not
carry it: their shape is unchanged.
When a repository requires checks, an approved pull that is green only
against an older main joins the queue as it is: the candidate's full gate
runs on main's tip with that pull merged, which is the proof a re-check of
its own would give, and a red candidate bisects as above. So a landing that
moves main does not send every other approved pull off for a check of its
own first; the batch lands in one gate. A pull's own check runs again only
when its head changes: an approval checks a head that was never checked,
and a green one only when main moved since and the repository is not
autonomous, whose land gates on today's main anyway (`src/checks/approval.ts`). A person's merge, which no candidate gated, still
refuses a stale green. Each sweep reads every open pull, oldest first, not
only the newest page, so an older approved pull is batched with the rest
rather than joining alone on its own event. The autonomy tick line counts the approved pulls the
last sweep saw and why each waits (`approved="3 approved: queued=2 review=1"`,
from `src/crew/waits.ts`), and what the queue is doing now
(`queue="gating 2 pulls since 18:54"`, `queue="1 waiting"` or `queue=idle`,
in UTC).

An autonomous app's planner is **held** while nothing is landing or the plate
is full: no pull has merged in 48 h while one was closed unmerged, or more than
`slots × 3` ready, unassigned issues are waiting. The tick log says which
(`planner: held`), and the board and the terminal's repository list say it in
words. A comment on the direction issue from someone who may write there lifts
the hold; an issue handed to the planner is still owed its pass.

Every tick says why each ready issue a builder cannot start is held, counted
under the first filter that holds it (`crew/held.ts`): `held: running=1
open_pull=10 stalled=12 run_cap=11` — a run on it, an open pull proposing it,
the planner's, found done on main and waiting for a person to close it
(`done_on_main`, never re-planned), shipped by a merged pull that left boxes
unticked and waiting for a person to answer (`landed`, `crew/landed.ts`), stalled, at its run cap, parked twice, covered by a red-main
fix, or a setting's finding. The flow panel on `/boards` draws the same per autonomous app as one
bar, and the terminal's Flow command prints it as a line per app
(`flow/held.ts`, kept 5 s). Of the startable, the picker takes the order Next up shows
(#8826, `pickOrder` in `core/next_up.ts`): the owner's ranked issues by place,
then the ready order, what the owner raised again first. Small issues — a title like "A test pins …" or
"Tests: …", or a label `test`, `tests`, `tests-only` or `small` (#7571, `crew/small_share.ts`) — hold
at most `slots.smallShare` percent of the builder slots (default 30, rounded up:
2 of 5; an admin sets it on `/settings/capacity`). At the cap a small issue is
skipped, not waited on, unless the owner ranked it. The tick line's `small: 1/2`, the
Flow command's `small 1/2`, the app's row in Today on `/boards` (`small
issues: 1 of 2 slots`) and the studio's crew panel show small issues in
flight of what they may hold. An issue labelled `polish` is a small issue too, and its run is stopped past `polish.capMinutes` (default 60) with one comment saying what is left (`crew/polish_cap.ts`, `docs/features/polish-cap.md`). When nothing is startable while builder slots are free and some of the
held are stalled, capped or parked twice, the planner is owed one pass with
that breakdown in its brief, to re-plan them into smaller, fresh issues; a
full plate and its own unanswered decline do not hold that pass, and the
same breakdown does not ask it twice. A stalled issue does not wait for that
pass: the next tick parks it with who stalled it and why, so another builder
picks it, and a second stall hands it to the planner past its day's cap
(`crew/stalls.ts`, `unstuck=N` on the tick line).

The forge asks the host for one more binary: `claude`, on `PATH` or at
`FORGE_CLAUDE`, authenticated as the operator (an `ANTHROPIC_API_KEY` in the
forge's environment is handed to runs; the machine's own Claude Code login
works when there is none). `FORGE_CREW_CONCURRENCY` (one per 3 GiB above 2 GiB, 2–16) and
`FORGE_CREW_BUDGET_USD` (5) bound it; `FORGE_CREW_CEILING_USD` caps what the
crew may spend across every repository in a UTC day, whatever each
repository's own ceiling says; `FORGE_APPS=0` turns apps and crew off. A preview whose pull nobody has
pushed to or commented on for `FORGE_PREVIEW_IDLE_DAYS` (default 3; `0` keeps
every preview warm) is stopped and reads as asleep, and asking for it wakes it.
An admin with more than one Claude account keeps them under Settings →
Subscriptions, sealed, and grants each to a repository (Settings → Crew) or
an organization (its page), down to one crew member: a work plan pays for
the work repositories and nothing else. Two on one grant take turns, and
one the provider rests hands its runs to the other until the reset.
**Model budget.** A new account has none: its repositories' crew does not run, spends nothing, and says "This repository has no model account". A person adds their own subscription at Settings → Model (or the terminal's **Model budget** command, `a`); it is sealed, granted to their own repositories only, and one per account. A forge admin who is a person gives an account a capped grant, in dollars a month spent on the forge's own credential, from the account's page, the terminal's **Model grant** command, `POST /api/v1/admin/accounts/:name/model-grant` (`{"usdPerMonth": 20}`, `null` takes it back) or the MCP `model_grant` tool; each change is in the audit. The cap is the UTC month's spend in the usage ledger, checked when a run starts and on every spend tick: a run past it stops, and its page says the grant is spent. Two runs that start together each begin with the whole remainder; the tick check ends both once the sum crosses the cap, so the overshoot is at most what they spend between ticks.

**Roles.** An account is a guest, a member or an admin (`docs/ROLES.md` has the table of what each can do; `src/core/roles.ts` holds it). Admin is the admin flag, a member is promoted, everyone else is a guest. A guest is refused creating a repository, making an app their own and starting a crew run, in words that say what a guest can do instead (after the older refusals: unverified, suspended, agent, private); nothing switches it off. A forge admin who is a person lists everyone with their role at Settings → People (`/settings/people`) and promotes a guest to member with one button, with an optional starter model allowance in dollars a month (none by default, given as a model grant and audited as one), or demotes a member (the allowance stays until taken back on the account's page). In the terminal it is the **People** command (`r` changes a role: `member 5`, or `guest`; `v` marks the email of the person under the cursor verified after a `y/n`, as the `account_verify` tool does over MCP, and unverified people are marked so; `s` suspends an account by name, or lifts the suspension, after a confirm saying their sessions and tokens stop at once, with the rules of `account_suspend`: not yourself, another admin or an agent, not the only owner of an organization; a suspended row says since when); over the API, `GET /api/v1/admin/people` (`{ items, next_cursor }`, as `/admin/accounts` and `/admin/invites` answer, with `limit` 1-200, 50 by default, and `cursor`) and `POST /api/v1/admin/accounts/:name/role` (`{"role": "member", "usdPerMonth": 5}`); over MCP, the `account_role` tool (a plan unless `dryRun: false`, with an admin token). Anyone signed in sees their own role and its row of the table: the account page (`/settings`) shows "What you can do here"; over MCP, `whoami_can` returns `{username, role, can, abilities}` with any token (with `{"kind": "passkeys"}` it lists your own passkeys instead, `{ items }` of id, name, created, lastUsed, people only; the page is Settings → Passkeys, and the terminal's **Passkeys** command lists them read only); in the terminal it is the **What I can do** command (agents included). When your email is unverified that screen says so, and `v` sends a new verification email, as the account page and MCP `email_verify` do; an account with no real address is told to add one from account settings in a browser instead.

**Crew subscriptions in the terminal.** A forge admin presses Ctrl+K and picks **Crew subscriptions**: each Claude account with its kind, what it pays for, budget, spend and whether it rests (never a token). `w` wakes the selected resting one (an awake one is left alone and said so), `b` asks for dollars, or `none`, and sets its whole-life budget. `a` adds an account: a name, then the token typed masked (drawn as dots, handed to the core once, never shown or logged), then an optional API base; a refusal is MCP `subscription_add`'s sentence, word for word. `D` shows that the subscription and its grants go and that past runs keep it in their history, and removes it only after a confirm that defaults to Cancel. Only a forge admin who is a person is offered either key; an agent sees neither and changes nothing. Granting an added account to a repository or organization stays on the web page and in MCP. The rules are MCP `subscriptions`, `subscription_wake` and `subscription_budget`'s, from `core/subscriptions.ts`; a budget set by whoever made the forge can be lowered, never raised or cleared.
**Where you are signed in.** Anyone signed in sees their own browsers and tokens, never a secret, at `/settings`, over the API (`GET /api/v1/users/:username/signins`), over MCP (`sessions`), and in the terminal as the **Signed in** command (`src/tui/screens/signins.ts`; a guest has no such command). The terminal lists this terminal's SSH key first, marked "this one", then each browser (`web browser` and the tail of its session id, so two read apart) and each token (name and scope), with when it was last seen and since when. `d` on a browser asks to confirm (Keep is the default) and signs it out through the same `endAccountSession` as Settings and MCP, so its cookie reads as signed out at once. `d` on a token asks `Revoke <name> (<scope>)?` (Keep is the default) and revokes it through the same `deleteToken` action as Settings and the API, so it stops working at once and open pages hear `token.deleted`. `d` does not end this terminal (disconnect, or remove its key in Settings → SSH keys); it says so. No browser row is marked as the current one there: the terminal holds no browser cookie.

**Invites.** A forge admin who is a person mints a single-use invite link with `POST /api/v1/admin/invites` (`{"days": 14}`, 1 to 30, 7 by default); the response carries the link once and only its hash is kept. `GET /api/v1/admin/invites` lists them (open, used, revoked, expired) without tokens, and `DELETE /api/v1/admin/invites/:id` revokes one. Minting, revoking and using a link are events (`invite.minted`, `invite.revoked`, `invite.used`; the last names the invite and the account it let in, never the token). The same is the **Invite links** card on `/admin/limits` (a form with expiry days, 1 to 30; the new link is shown once, with a copy button; an open link has a Revoke button) and the terminal's **Invite links** command (`m` makes one and prints the link once, `x` revokes the selected open one; its top line says who may sign up, and `s`, offered only to that admin, picks open, invite or closed, shows from → to and changes it after a confirm, as MCP `signup` does). Over MCP, the `mint_invite` tool (`{days?}`, an admin token, a forge admin who is a person) answers with the same link, and the `invites` tool (`{action: "list"|"revoke", id?}`, the same person admin and admin token, for both actions) lists them without links or revokes one. While signup is `invite`, the link opens the door once: `/signup?invite=…` (the form and the passkey door) or `invite` in the `POST /api/v1/users` body. In the terminal, with signup = invite the create-account screen has a fourth, masked **Invite** field that takes the token (not the whole link); a blank one is asked for, and a bad one is refused with the same sentence as `/signup`. The account and the invite's use are one write, so two sign-ups with one link make one account; a used, revoked or expired link, or any link while signup is `closed`, makes none. While signup is `open`, a link is not spent.

**Bulk actions in the terminal.** A person (never an agent) presses Ctrl+K and picks **Bulk actions** (`src/tui/screens/bulk.ts`): their own last 30 bulk actions, newest first, as `GET /api/v1/fleet/ops` lists them, each with its action, how many rows changed, how many were refused, whether `u` still undoes it, and when. `j`/`k` move; `u` undoes the selected one while it is inside its day, through `undoFleetOp` (`undoAsksBulk` for a bulk action on asks), and toasts the outcome; an undone, expired or non-reversible receipt, or an undo itself, says why and changes nothing. Enter opens the operation's rows: each row's before → after, and each refusal's reason. Another person's operations are never listed. An agent is not offered the screen and, reached another way, sees "Not available".

**Spend ceilings.** Apart from the grant, a forge admin who is a person may set any account's — a person's, an agent's or an organization's — daily (UTC) and per-run ceilings in dollars: on the account's page (`/settings/accounts/<name>`, an organization's too, by that address; an agent and an admin's own account have no such page), the terminal's **Model ceiling** command, `POST /api/v1/admin/accounts/:name/ceiling` (`{"dailyUsd": 20, "perRunUsd": 5}`) or the MCP `model_ceiling` tool; each change is in the audit. Both empty on the page, `none` in the terminal (its prompt shows the current ceilings, and an empty answer changes nothing), or `null` for both on the API and MCP takes them back. An organization's page is linked from its own page for an admin. An account has no ceiling until one is set, so this forge's own crew is never stopped by a default nobody chose. A run on an account with a ceiling does not start when the day's is spent or the per-run one is too small, is capped at the smaller of the per-run ceiling and what is left of the day, and stops mid-run when the day's is spent.
**Sandbox.** An agent's shell is held to a policy — the network is the forge
and the package registry, writes stay in the clone, the forge's data and the
operator's credentials are unreadable — by bubblewrap and socat on Linux
(both are in the image). Inside it a builder can install the declared
packages, type-check, and run the tests that boot a server: no unix socket is
let through, so the run carries `FORGE_TEST_SOCKET=port` and the forge listens
on a loopback port instead (`bun scripts/sandbox-probe.ts` prints each
verdict). A host that forbids unprivileged user namespaces
(many container platforms' seccomp profiles) cannot hold it, and the policy is
then switched off rather than faked. To tell which a deployment is in: the
boot log carries `agent sandbox not available here` with the reason, Settings →
Crew shows **Unsandboxed** with it, and every agent run's page says
"Sandboxed" or "Unsandboxed" from what it was actually started with (runs
from before this record say nothing). Claude Code bridges that sandbox with
two `socat` relays per session, in the session's process group; when a
session ends, however it ends, whatever is left in that group is killed. A
`processes` line once a minute counts what runs beside the forge by name
(`top="socat=… bwrap=…"`), and kills any bridge whose session is gone
(`reapedBridges=N`). Every start is counted in `boots.json` under the data
directory: the boot line and every autonomy tick line say `restarts=N`, plus
`unclean=N` for starts that ended without an orderly exit (a crash or an OOM
kill, which leave nothing in the log themselves).

`docs/FLOW.md` is where every issue stands: `GET /api/v1/repos/:owner/:name/flow` returns each open issue's stage, since, stalled and unblock, plus what went live in the last 24 h.
Where the whole forge waits is the owner's, on `/boards` (the old `/flow` redirects there, query kept; an agent granted `telemetry:read` reads the same from `/api/v1/telemetry/flow` and the MCP `flow` tool): the flow panel shows each stage from ready to live with what waits, the oldest wait and its capacity, under one sentence naming the bottleneck, and beside each what it let out in the last hour with a 24-hour sparkline, under a line of landings and the median ask→live — every count links to the items it counts. A stalled step is a card on the home (Studio mode) for anyone who can write to the repository: an open pull whose check was never asked for, or is red, past its stage's allowance, with its stage, how long it has been stuck, and one button — Run check or Re-run — that asks for a check at the head and returns to the home. The terminal's **Stalled steps** command (palette) lists the same steps, live, and Enter or `r` does the same re-run; both read `flow/stalled.ts` and act through `flow/unblock.ts`, and neither shows anything to someone who cannot write. A conflicted pull never sits: every tick the crew's open pulls that no longer merge get one bring-up-to-date run each (one in flight per pull), oldest pull first and only as many as the check lane has slots for, since each ends in a push and a check: check slots minus the checks queued and running minus the runs already in flight, with one always allowed (`crew/conflict_room.ts`, #4459); after 2 failed tries in the same conflict, or 24 h since the first, the pull is closed with the conflicting files named and its issue goes back to ready, unassigned, with no strike against the builder. Conflicted pulls are listed oldest first on `/boards`. The terminal's Flow command and the MCP `flow` tool read the same: the sentence, the landings line, and each stage's count out in the last hour and in 24 h.

`/resilience` is a forge admin's too (a guest is sent to sign in, anyone else gets 404): each protection in `docs/THREATS.md` as one line, green, red, untested or "no test yet", judged by the test file it cites in the last full gate of the forge's own repository (`FORGE_REPO`; other repositories' gates never touch it). The terminal's **Resilience** command (palette, admins) lists the same lines under where snapshots go now; for an admin who is a person, `d` seals a destination field by field (both keys typed masked, checked as the Backups page checks them) and `x` forgets it after a confirm; `m` and `f` do the same for the off-box mirror. No key is ever drawn.

The terminal also has an Access command (`:` → Access), a site admin's: it reads the same last-day non-browser requests as Settings → Access and the `access` MCP tool, newest first, and filters them with `s` (since), `u` (user agent) and `p` (path), `c` to clear.

`/system` is the machine, for the owner (#1789), laid out like btop (#2721): a meter and a 30-reading block-character history per core, memory and swap meters, load, hwmon temperatures, disk use per mount, disk and network rates (`/proc/diskstats`, `/proc/net/dev`), and a table of every process grouped forge / check (`check:<run>`) / app (`app:<slug>/<env>`) / host with CPU, memory and age, sortable by CPU (`c`) or memory (`m`) or the buttons (shown only with a script; without one the order is by CPU). It reads `/proc` and `/sys` and updates in place over one event stream, `/system/stream` (`?pause` holds it still; no reload, no polling); the 2 s push timer runs only while someone is subscribed, so it costs nothing unwatched. Its history is the `machine` board source. A test file running in more than one check at once is counted at the top of `/system` and the `/boards` flow panel, with the checks. Command lines are never kept — only `*.test.ts` arguments.
In the terminal, `:` → System shows the same view (the owner's only): per-core CPU with a block-character history, memory, swap, disk and network rates, and each group's top two processes (no sort; the dialog is read-only), below them three sparklines (CPU, memory, load) of the node over the last 6 hours, each with its latest value and peak, read through `historyOver` like the MCP `telemetry_history` tool; `h` cycles the window 1 h / 6 h / 24 h / 72 h, a window with nothing recorded says `no readings yet`, and anyone that tool refuses sees no line. `:` → Telemetry lists the agents and flips `telemetry:read` for the one you press Enter on.
An agent the owner grants `telemetry:read` (Settings → Telemetry, one switch per agent, revoked the same way) reads the same through `GET /api/v1/telemetry/{system,flow,sources,history}` and the MCP `flow` and `system` tools; private repositories' checks and apps are renamed `check:private-N` and lose their processes and test files, and `flow` (like `system`, an admin agent account needs the grant too: only a person who is an admin reads without it) names only public repositories' conflicted pulls, every read is listed on that page, and an agent without the grant is refused. `/contribute`, `GET /api/v1/contribute` and the MCP `contribute` tool are open to anyone: what the forge is, the bottleneck now, open issues labelled “help wanted” in public repositories, and how to propose (fork, pull, the same gate). The grant is a table, not a token scope, so no token has to be re-issued.

**Raw files and caches.** `GET /:owner/:name/raw/:ref/*path` at a full 40-hex commit id is `immutable` for a year: `public, max-age=31536000, immutable` for a public repository, `private, max-age=31536000, immutable` for any other, so a shared cache never keeps private bytes. At a branch or tag it is `private, max-age=0` and revalidates. Every raw answer has the blob's oid as its `ETag`, and a matching `If-None-Match` gets a 304 with the same `Cache-Control`, `nosniff` and sandbox CSP. The HTML blob page is not cached this way (it carries the viewer and a nonce). A public repository that later turns private keeps its year-long `public` copies in shared caches already holding them. See docs/CACHING.md.

`docs/PLANNING.md` is how issues depend on issues: the edge, the map, and
what "ready now" means to a person and to the crew. The map draws open
issues by default; `?done=1` ("Show done") draws the closed ones on an edge too. The map also shows each
pillar's ask-to-live: the median hours from an issue opening to its change live
in production, over the last 7 days (also in the map and milestones API and MCP).
It reads the `deploy_pull` record a production deploy writes when it finishes,
so a page view runs no git; an issue closed by several pulls counts once, at
its first time live. On boot the forge records what the last 7 days of earlier
production deploys carried, so work that went live before the record is counted.

## The crew's shell

An agent's shell runs inside Claude Code's sandbox (`src/crew/sandbox.ts` is
the policy, `src/crew/claude.ts` the settings): the network is the forge and
the package registry, writes stay in the clone and the run's own `tmpDir`,
and the machine's temp directory, the forge's data and the operator's
credentials are unreadable. No command runs outside it on request.

Bun's install cache is one per repository, `<data>/crew/.cache/<repo id>/bun` (`BUN_INSTALL_CACHE_DIR`): every run on a repository shares it, no two repositories do, and deleting the repository deletes it.

### Running this repository's tests inside it

On Linux the sandbox refuses the bind of a unix socket, and the forge's
internal listener (the git hooks' door) is one. Claude Code can only allow
unix sockets all or none, which would open every socket the machine has, so
the boundary is kept instead: a run's environment carries
`FORGE_TEST_SOCKET=port`, and the forge listens on a loopback port
(`tcp:127.0.0.1:<port>`, `src/git/hook-address.ts`) where it would use a
socket. Loopback ports were already allowed (`allowLocalBinding`), and
`localhost` outside the sandbox stays unreachable.

What an agent can run: the type check and `bun test` over `test/`, with no
failures. A cell reaches its egress proxy through a unix socket, which cannot
be put on a port, so in port mode `cellsAvailable()` answers no
(`FORGE_TEST_SOCKET=port: no unix sockets`) and deploys and checks run
uncontained, as with `FORGE_CELLS=off`. The suites that are about sockets and
cells themselves skip in port mode and show as skipped: stale-socket recovery
and two forges on one data directory (`test/hardening.test.ts`), the egress
proxy and the cell-limit and probe suites (`test/contain.test.ts`), and the
socket-copy test in `test/apps-adversarial.test.ts`. The forge's check runs
them on every push and sends the log back.

Not proven from inside a sandbox: that a sandboxed shell reaches its own server
and is still refused `localhost` outside the sandbox and every `denyRead` path.
Nesting a sandbox is not possible there, so `test/crew-sandbox.test.ts` checks
the settings that enforce it (`allowLocalBinding` on, `allowAllUnixSockets` off,
the `denyRead` list) and not the boundary itself.

## Where a run's time went

Every run that started ends its log with one `timing: run ended …s after the run started — clone … · brief … · harness …` line (plus `wrap-up` when the reserve was used), whatever way it ended; `src/apps/timing.ts` draws it.

## The sentinel (#1131)

The forge hunts its own faults. `src/crew/sentinel.ts` runs on the autonomy
clock (a hunt an hour; a signal may bring one sooner, never within ten
minutes). It reads what the forge already holds — the run table, the decision
ledger (`retry stop` streaks, `guard` parks, a direction at its cap),
`sqlite_master` for triggers the schema does not create, and the error ring —
and names each fault with the evidence quoted (secret-shaped text scrubbed).

Each finding is exactly one open issue, keyed so it is never filed twice; a
finding still there is a comment, and only when the evidence changed. The board
strip shows the last hunt and the count of open findings. The whole of it is
`docs/SENTINEL.md`.

Left to a person on purpose: ingress routes at the edge are not in the
database, and the sentinel opens no pull itself — a finding with a mechanical
fix says what it is, and a run of the crew picks the issue up.

## Hot files (#5934, #6235)

A build is not started while a file its issue names is touched by 5 or more
open pulls (`HOT_PULLS`). A pull whose diff against the base tip touches more
than 60 files (`WIDE_PULL`) counts toward no file's heat: such a diff is
almost always the base's history on a conflicted pull, not its own work, and
five of them would make hundreds of files hot and hold the whole map. It is
named instead, with its file count, on the feed post that says what waits
(`too wide to count: #4840 (1,081 files)`), so a person can close or rebase
it. A real sweeping change, such as a rename across the tree, goes uncounted
too; it conflicts with everything anyway, and it is named.

## Passports

A crew run's environment carries `FORGE_PASSPORT`, a 15-minute credential
scoped to `health:read` for the forge alone (`src/kernel/passport.ts`, no
dependency: Node crypto's HMAC and HKDF). It opens one route and nothing else:

    curl -H "authorization: Passport $FORGE_PASSPORT" "$FORGE_URL/api/v1/passport/health"

Missing, expired, wrong-audience, wrong-scope or forged passports get a 401. A
passport has exactly one valid encoding (padded or altered variants are refused).

This route proves the mechanism and is not a privilege: it returns what the
anonymous `GET /api/v1/health` already returns. The next edge should guard
something only a passport may reach.

## Seeing the direction a vision pull will write

An open vision pull's page shows, to an admin of the repository, "Direction after the merge": today's direction beside the one an admin's merge will write, computed by the same `nextDirection` the merge uses (`src/crew/vision.ts`), so the two cannot differ. Repository settings (Crew) marks the direction's fenced block `follows docs/VISION.md` and the words around it `the owner's`. Today and After the merge stack vertically at every width.

The same read is a second door: the MCP `vision` tool takes an optional `number`, and for an admin returns `preview` (`{ today, after }`, or `{ why }` the direction would stay) for that open vision pull, plus `directionParts` (the direction cut into `vision` and `owner` parts). The terminal (TUI) has no such view; it is not touched by this change.

## The weekly pace reads the provider's measure (#8960)

The pacer decides from the percent of the week the provider reports as used
(`subscription_measure`, noted from the session's `rate_limit_event`) against
the share of the week's time gone. No dollar cap is inferred. Its burn per
hour is the fall of that percent between successive readings, so a meter that
has not moved reads 0% an hour. With no measure (never reported, or its week
has reset) the sentence says the pace is unknown and the crew holds at a
modest level; it is never off. `crew.concurrency` is not lowered in the
repository (the chart and `capacity.ts` defaults are the ceiling); pacing is
what slows the crew now.

An admin sees the measure in `usage` (the MCP tool and the usage page): each
subscription's `headroom` lists the window's percent free and its reset, taken
from the provider's measure while its window is open, else inferred from the
ledger. The terminal reads the same `readForgeUsage`: the Usage screen prints
each subscription's `week 38%, 5h 80%` line, and the forge usage block
`week 38% free`; home and the dashboard print the pace sentence.

## What the pace limits (#8962)

The week's pace (`src/crew/week.ts`) limits only the crew's own picks: the
builds the tick assigns under the operator's name (marked `pick` on the
`issue.assigned` event). Reviews and issues a person assigned are not slowed
by it: while the pace allows any slots at all, up to `pace.floor` of them (a
capacity setting, env `FORGE_PACE_FLOOR`, default 2, 1 to 16, read on every
pump) run at once, apart from the picks; it is also the fewest slots a fast burn
slows a repository to. At the reserve's wall (no slots) everything waits for the
reset. Not covered: feedback, check and conflict runs still count with the picks.

A person's assignment is marked `person` on its `issue.assigned` event. An
assignment event with neither mark was written before the marks existed and is
held as a pick: an `assigned` run queued before this deployed uses the pace
like a pick until it starts, then the cutover is over (no migration).
