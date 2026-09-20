# The studio

Two ways of seeing one forge. **Studio** is the default: apps are the unit,
and a person does three things to one — tell the crew, look at what it
made, decide when it asks. **Dev** shows the git underneath — code,
commits, branches, runs — unchanged. The switch is in the top bar and is a
cookie on that browser; the URLs are the same in both, so a link works
whichever way its reader sees.

## Five words

Every word on a studio page is one thing in git, and dev mode shows it.

| studio says  | git underneath                                          |
| ------------ | ------------------------------------------------------- |
| **tell**     | an issue, assigned to a builder by the routing decision |
| **working**  | a run, streaming its log                                |
| **look**     | an open pull with a green check and a preview           |
| **shipped**  | a merge to the default branch, production redeployed    |
| **asks you** | a pull the crew stopped on, or a green one for a look   |

Every word above is decided in one place (`runWord` and `pullWord`,
`src/web/studio/words.ts`), from facts — never from a run's own summary
text, which stays the note beside the word. A run's word comes from its
state, and once it is over, from what it produced: a pull, judged by
`pullWord`, or nothing to show, which is *planned* rather than a guess at
*shipped*. A pull's word comes from its own state: open goes by its check
(`checkRunWord`), closed without a merge is *stopped*, and merged is
*shipped* only once production's live commit is at or past the one the
merge carried (an ancestry check in git, not equality — a later merge
already deploying it still counts). Between a merge and production
catching up, the word is its own honest one — *working* while production
deploys it, *stopped* if that deploy failed, *waiting* if production has
not started on it yet — and it becomes *shipped* on the next render or
live event, no reload needed. The app page, the change page and the home
all call the same two functions; nothing here is re-derived per surface.

These are also a kanban board: tell is the backlog, working is in progress,
look is review, shipped is done, asks you is blocked. The crew's slot count
(**Settings → Autonomy**) is the WIP limit. The map is the plan. A week's
level-and-flow chart on the map is the cycle. Green check, preview, merged
is the definition of done. None of that needs its own vocabulary on the
page: the studio only offers principled moves.

## The app

An app's home in the studio (`/:owner/:name`, when the repository is an
app) shows, top to bottom: what it serves and where; the box; what asks
you; what is happening now. Beside it, who is on the crew and what each is
for, this week's numbers (shipped, runs, spend, spend per shipped change),
and how the repository runs itself, when it does — each **Change** button
leading to the one place both are set. The page keeps itself
current about deployments: a deploy run for the app being viewed refetches
the head card and previews list in place, so a change serving in its
preview shows up without a reload.

**How this app runs itself** (`/:owner/:name/settings`, in studio, on an
app) is that one place: the crew, each with their role in the studio's
words (builds, reviews, plans) and their brief, with add, change-role and
remove, and beside it whether the app is assisted or autonomous, the day's
ceiling, how many may work at once, and whether it is paused and why. It is
a studio page over the very same actions dev's Crew and Autonomy settings
already use (`src/actions/crew.ts`, `updateRepoSettings`) — same
same-origin check, same authorization, same errors; nothing here decides a
mutation a second way. *The rest of the settings* — visibility, the
default branch, branch protection, labels, webhooks, environment
variables, deploy keys, danger — stays dev's, one link away
(`?mode=dev`), where the tab strip still has Crew and Autonomy of its own.

**The owner's facts and the public's.** What an app *is* — its description,
whether it is live, its address, the look, *Open the app*, and how many
changes it has shipped — is the point of a public app and stays on the
page for anyone who can read the repository, signed in or not. What
running it *costs* — every dollar figure, the day's ceiling and slot
count, the decision ledger, and who is on the crew — is the owner's own
book-keeping, not the app's, and is computed at all only for a viewer who
can write to the repository: `canSeeOwnerFacts` (`src/core/repos.ts`,
today exactly `canWrite`) is the one predicate every surface asks before
it renders or even queries one of these — the studio page, its live
`/app/state` fragment, its own crew-and-autonomy settings page, a run's
own page and its JSON and live-tail answers over the API, and the board.
The forms that change either render only for who the underlying actions
would let post — an admin, exactly as dev's pages already require — so a
writer who is not an admin sees the same facts with no controls that would
just come back refused. What is happening now still reads as
the app's own story for such a viewer — a change being built, a preview
coming up — but by "the crew" rather than an agent's own name, and never
with a run's cost, turns or steer box. A private repository is unaffected:
it already answers only to people who can read it at all.

**The terminal** is the same operator's door, so it sits beside the same
facts: a writer sees the exact `ssh …` command production answers to,
copyable, with the forge's host key fingerprint beside it, or one line
saying the terminal is off — no SSH listener on this forge, or this
app's `forge.json` declares no `tty` (`docs/APPS.md`, _A terminal for
every app_). A pull's own preview card shows its own command the same
way, since a preview answers to a different login than production's. A
reader sees none of this. Both surfaces call the one function that knows
the fact, `terminalFor` (`src/actions/apps.ts`), so the dev App page and
the studio page never carry two ideas of what the command is.

**The box** is the front door. A sentence becomes an issue — the first line
its title, the rest its body — and the routing decision hands it to a
builder: the builder with the least in flight, then by name. That is one
fixed-choice function (`crew/autonomy.ts`, `pickBuilder`), the place a
faster or wiser decider plugs in. The run starts on the crew's next tick,
and the page shows it waiting, then working.

**Asks you** is every parked question a person has to answer, three
sentences each with the real options in place. A pull the crew stopped on
— red past the crew's own limit since a person last spoke — offers _tell
them what to try_ (a comment, which starts a feedback run), _close it_,
and _see the change_. A green pull waiting for a look offers _open the
preview_, _ship it_ (a squash merge, as you, with your review and check
requirements enforced inside it), and _not like this_ (a comment); its row
leads with the preview as pictured on a phone (`docs/APPS.md`, _The look_),
and the picture opens the pull, where both pictures are. A repository
paused at its ceiling says so, with the way to settings. A pull
the crew is on right now — a run queued or running for it — is working,
not a question, and is not listed until the crew is done with it. An
autonomous app's green pulls are never a question: the decider and the
crew's reviewer look at them, and conflicts with `main` are the builder's
to fix, so what reaches you from an autonomous app is only the day's ceiling;
what the crew cannot finish it parks and re-plans rather than hands to
you. Shipping a pull that conflicts, from any app, sends its agent
to bring the branch up to date rather than handing you the conflict. Nothing
here re-queues anything: a re-queue button is what an operator presses
instead of deciding.

Check several asks and one bar above them offers what fits them all — ship
the green ones, close the stopped ones — as one decision (`POST
/studio/asks`), each done exactly as its own button would have. Deciding
never leaves the page: the row looks busy until it lands, then goes; one
that could not be done stays, with the reason on it.

When a decider is configured, an ask card's own option can carry a **lean**
— a small word (_likely_, _probably_, _maybe_) beside the option a careful
owner would pick, from asking the decider the same question a person is
looking at. The lean is never why the page waits: a card renders with
whatever lean is already known, and a card with none yet is asked for after
the page is on its way to the browser, so the answer is there on a later
render, not this one. A forge with no decider configured shows no lean and
asks nothing, exactly as before deciders existed.

**Now** lists what was told and not yet picked up, every open pull with its
state, and the last runs, each in one of the five words with who and when.
A run in flight carries _Stop_ (running) or _Cancel_ (waiting) for anyone
who can write here; its title opens the transcript, where the agent can be
steered mid-run (see `docs/APPS.md`, _Runs_).

## The three lists

`/:owner/:name/issues`, `/pulls` and `/runs` on an app, in the studio, are
*everything told*, *every change* and *every run* — dev's tabs with dev's
issue numbers, labels, milestones and branch names replaced by the same
five words the rest of the studio speaks. Each is a page of rows, newest
first: who has it (the assignee, the author, or who ran it), when it last
moved, its state as `wordBadge` draws it (`src/web/studio/words.ts`), and
one link — the row itself — to the tell, the change or the transcript. The
app page's own footer (`the map · everything told · every change`, and
*Every run* above **Now**) and the repository header (`Told`, `Look`, in
place of dev's `Issues`, `Pulls`) both land here; the header's own tabs
keep dev's names, and dev's `Commits`/`Branches` stay dev's alone.

A row's word comes from `tellWord`, `pullWord` or `runWord` — the one place
each is decided, never re-derived here. `?word=told|working|look|shipped|
stopped` is a link at the top of each list, never a form, so a filtered
view has its own address to share; with no `word` the list shows what is
open and moving — told, working and look, never shipped or stopped, the
same split "Open" draws elsewhere. `waiting` and `planned` — a merged pull
production has not caught up to yet, or a run with nothing to show —
still read as *working*: still moving, not one of the five a list links to
on its own. Paging is the underlying list's own cursor, unchanged; a word
filter narrows the page it lands on rather than inventing a second scheme.
`?mode=dev` on any of the three is dev's list, exactly as it always has
been; a repository that is not an app renders dev's list here regardless
of mode, since there is no studio to switch to.

## A tell, on its own page

`/:owner/:name/issues/:number` on an app, in the studio, is a tell — one
sentence someone said to the crew — not dev's labels, milestones and
dependency form. It answers three questions: who has it (or that nobody
does yet), what it is waiting on and what waits on it (`dependenciesOf`,
`src/core/dependencies.ts`, each a link, read-only here), and what the
crew has done with it — every agent run, newest first, who ran it, how
long it went, what it cost and its state in the studio's own word
(`tellWord`, `src/web/studio/tell.ts`), its title opening the transcript
— and the pull that closes it, with its check and a link into its
preview, when one exists. The sentence itself, and the reply, are the
conversation dev's page shows too (`conversation`/`composer`,
`src/web/pages/thread.ts`): the same action, the same same-origin check,
told once. The repository's own standing direction is not an ordinary
tell — it never gets picked up on its own — and the page says so rather
than showing it as waiting forever. *Read the details* is one link away,
`?mode=dev` on the same URL, where labels, the dependency form and the
assignee control stay the only place those exist; an issue on a
repository that is not an app, or any issue in dev mode, renders exactly
what it always has.

## Working, on its own page

`/:owner/:name/runs/:id` on an app, in the studio, is a run: who is on it,
the tell it came from (linking to it), how long it has gone and what it has
cost, and its state in the studio's own word. The transcript is the page's
body, tailing live with a fixed-height scrolling area and a cap on how many
lines it holds — a long agent run never grows the page without bound; with
JavaScript off the page still shows what was logged and refreshes itself
while the run is in flight. Once the tell has become a pull, its preview is
on the page as soon as it exists — this is the page someone sits on while
waiting for a change to become visible. Steer and Stop are here for anyone
who can write, through the very same routes and checks dev's page uses.
_Read the transcript_ links to dev's page (`?mode=dev` on the same URL),
unchanged; a run on a repository that is not an app, or any run in dev
mode, renders exactly what it always has.

## The look, on its own page

`/:owner/:name/pulls/:n` on an app, in the studio, is the change itself —
never its diff. The title and the opening post in the author's own words,
who made it and when, the check in the studio's five words (`pullWord`,
`src/web/studio/words.ts`) with its deploy one click away, the preview's
state with the link that opens it (`previewCard`, the same card the aside
carries in dev), and the look at phone and desktop width when one has been
taken (`lookCard`, docs/APPS.md). Below that the same decision an ask card
offers — ship it, or say what is off — through the very same `mergePull`
and comment actions, and the conversation: read it, add to it. *Read the
code* is one link away, `?mode=dev` on the same URL, landing on the diff
page exactly as it always has, deep links and all. Nothing here reads a
diff or a blob: the page costs a handful of small queries whatever the
change's size, unlike the page it links to.

## The home

`/` in the studio: what asks you across every app you can land, what is on
you (issues and pulls a person assigned to you), and your apps — each with
whether it is live, what the crew last did there, and a way in. That row is
a *shelf row* (`src/web/studio/shelf.ts`): one function turns repositories
into rows, from grouped reads, so every page that lists apps lists them the
same way and the home only decides the card around them. **New app** is the
same flow as ever. `/?mode=dev` is the repositories list, and — like
the toggle in the top bar — it switches this browser to dev from then on;
`/?mode=studio` switches it back, the same way.

The top bar carries the same count, on every studio page: a pill beside the
wordmark, linking here, naming how many things ask the signed-in person —
`askCountFor` (`src/web/studio/asks.ts`), the candidates `decisionsFor`
itself builds its cards from, before either the words or a preview picture
are read, so the two can never disagree. With nothing asking, the bar shows
nothing rather than a zero. It is studio's own; dev's top bar never carries
it. On a page that already streams (the home, an app, the map, the board)
the bar's own live region rides that same stream — no second connection.

The home keeps itself current. *Asks you*, *your apps*, *happening now* and
*on you* are each a live region (`data-live`, `src/web/client.ts`): a deploy
serving, a pull opening, closing or merging, a run starting or ending, or an
assignment changing refetches the home — the very same `studioHome` render
that drew the first paint, never a second copy of that markup — and swaps
just that region in place, so a card that is answered goes and a new one
arrives without a reload. Events within half a second of each other cost one
fetch. A card mid-decision (its post to the crew still in flight) is never
swapped out from under the click deciding it.

Signed out, `/` in the studio is a stranger's front door, not the dev
pitch: a shelf of the public apps actually serving — name, one line of
description, live state, and production's own picture, linking straight to
the app. Sign in and Create an account stay one click away; `/?mode=dev`
still renders the dev landing, and switches this browser to dev, same as
the toggle. A forge with no public apps yet —
most people's first visit — falls back to that same dev landing rather
than showing an empty shelf.

## The board

`/board` is the home's _Happening now_ as a wall for a second monitor
(**Focus** on that card opens it): no top bar, dark unless you chose a
theme, four regions that fill the window. **Working now** is one card per
run in flight — who, which app, what it is on, why, how long, what it has
cost — ordered by when it started. **Landed** is the last dozen shipped
changes across your apps, each with the app's production look on a phone.
**Decided** is the last dozen entries in the decision ledger: which issue
next, ship or show, try again — the answer, how sure the decider was, and
what came of it. **Today** is one row per app that runs on its own: spend
against the ceiling, runs, shipped, and whether it is paused. Every region
is live — it swaps itself when a matching event lands, and the dot in the
corner says whether the stream is connected. `?apps=a,b` narrows it to some
apps. Keys: `f` fullscreen, `1`–`4` one region full-bleed, `0` all.
Everything links somewhere; nothing needs a click. The board is a wall for
apps you can write to: a public app someone else owns can still appear in
it (`listReposVisibleTo` includes every public repo), but its cost, and
whoever is on its crew, never do — that row says only "the crew" and
carries no dollar figure, same `canSeeOwnerFacts` as the app's own page.

## What the studio never does

It never says _shipped_ before production redeployed, never hides that a
run cost money, never shows a preview that is not the pull's real head, and
never invents an answer for a card. The complexity is removed from the
surface, not from the system.
