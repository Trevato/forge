# The studio

Two ways of seeing one forge. **Studio** is the default: apps are the unit,
and a person does three things to one — tell the crew, look at what it
made, decide when it asks. **Dev** shows the git underneath — code,
commits, branches, runs — unchanged. The switch is in the top bar and is a
cookie on that browser; the URLs are the same in both, so a link works
whichever way its reader sees.

Finding something never leaves the page you're on. `/` focuses the search
box in the top bar, unless a field already has focus; `Cmd/Ctrl-K` opens the
command palette from anywhere, a field included. The box takes its query to
`/search` (`searchPage`, `src/web/pages/search.ts`), the one search in
both faces, server-rendered with no script: every repository the viewer
can see, matched by name or description, an app saying whether it is live,
then every tell and change whose title mentions the word, each saying
which app it's on and linked by the studio's noun — the same `search()`
the API and the palette ask, so a signed-out reader sees only what a
signed-out reader would anywhere. The studio's face leaves code to dev's:
it says _Search the code_, a link to the same page with `?mode=dev`, which
keeps that face on every link and the form until the reader leaves. The palette starts from a short local
index — your own apps, then places and actions like Home, Apps, Map, New
app — and past two characters asks that very same search, folding its apps,
changes and tells in under their own headings (`rankPalette`,
`src/web/palette.ts`), so what it turns up can never disagree with the page
behind it.

## Five words

Every word on a studio page is one thing in git, and dev mode shows it.

| studio says | git underneath                                          |
| ----------- | ------------------------------------------------------- |
| **tell**    | an issue, assigned to a builder by the routing decision |
| **working** | a run, streaming its log                                |
| **look**    | an open pull with a green check and a preview           |
| **shipped** | a merge to the default branch, production redeployed    |

Every word above is decided in one place (`runWord` and `pullWord`,
`src/web/studio/words.ts`), from facts — never from a run's own summary
text, which stays the note beside the word. A run's word comes from its
state, and once it is over, from what it produced: a pull, judged by
`pullWord`, or nothing to show, which is _planned_ rather than a guess at
_shipped_. A pull's word comes from its own state: open goes by its check
(`checkRunWord`), closed without a merge is _stopped_, and merged is
_shipped_ only once production's live commit is at or past the one the
merge carried (an ancestry check in git, not equality — a later merge
already deploying it still counts). That check is one `git rev-list` of
production's commit per repository per page, memoised on the page's
`WordCtx` (`servingHistory`) and read by every row — never one git process
per row, and never kept past the render. Between a merge and production
catching up, the word is its own honest one — _working_ while production
deploys it, _stopped_ if that deploy failed, _waiting_ if production has
not started on it yet — and it becomes _shipped_ on the next render or
live event, no reload needed. The app page, the change page and the home
all call the same two functions; nothing here is re-derived per surface.

These are also a kanban board: tell is the backlog, working is in progress,
look is review, shipped is done. The crew's slot count
(**Settings → Autonomy**) is the WIP limit. The map is the plan. A week's
level-and-flow chart on the map is the cycle. Green check, preview, merged
is the definition of done. None of that needs its own vocabulary on the
page: the studio only offers principled moves.

## The app

`/:owner/:name` in the studio, on a repository with no app record, keeps
the studio's own framing rather than silently becoming dev's code page: one
card above the code says in one line that this repository has no app yet,
with a door to make it one — `/settings/app`, the same "Run as an app" form
Settings already carries — open only to whoever could submit it (`canAdmin`);
a reader sees the sentence with no button that would just come back
refused. `?mode=dev` on the same URL is unaffected: the card is the studio's
own, never dev's. `/tells` and `/changes` on such a repository still send a
studio viewer on to `/issues` and `/pulls`, as they do for any repository
the studio does not apply to — the card names the one thing to do here,
not a second front door onto lists that would be empty anyway.

An app's home in the studio (`/:owner/:name`, when the repository is an
app) shows, top to bottom: what it serves and where; the box; what asks
you; what is happening now. Beside it, who is on the crew and what each is
for, this week's numbers — shipped, runs, spend, spend per shipped change,
and how fast a change reaches its preview, worded as `reaches its preview in
6.1s` and split beneath it into waiting to be picked up and coming up, each
its own median (`previewLatencyWords`, `src/web/studio/app.ts`) — and how
the repository runs itself, when it does — each **Change** button leading to
the one place both are set. Below three served deploys this week the line
says there are not enough to trust a median, rather than printing one from a
run or two; when some of the week's deploys never reached a preview at all,
it adds how many of how many, linking to them, and says nothing extra in a
clean week. The page keeps itself
current about deployments: a deploy run for the app being viewed refetches
the head card and previews list in place, so a change serving in its
preview shows up without a reload. **Redeploy** and **Stop** therefore stay
where they were pressed — the app's page, or a change's — rather than
leaving for the deploy's run: the card refreshing in place is what shows
the result, and the flash says what was done. The page to return to is the
referer, and only when it is this forge's own origin (`safeBack`,
`src/http/context.ts`), never a form field; with no referer it is the
repository's home. Dev mode's Redeploy still hands over to the run.

This page is the app's only page. Dev's App page folded into it (#395):
`/:owner/:name/app` answers with a redirect here (`appPage`,
`src/web/pages/apps.ts`), adding `?mode=studio` for a dev browser — dev's
repo home is the code — and the same not-found as ever for anyone who
cannot see the app. What that page had and this one lacked were the
environment controls, so they moved: each row in the previews list carries
its own **Redeploy** and **Stop** for a writer, beside its state, with its
host still the link that opens it; and an admin's footer carries
_Environment settings_, the way to the app's variables, hostname, access
and domains (`/:owner/:name/settings/app`). The App tab and the app strip's
button in dev are links to this page.

**How this app runs itself** (`/:owner/:name/settings`, in studio, on an
app) is that one place: the crew, each with their role in the studio's
words (builds, reviews, plans) and their brief, with add, change-role and
remove, and beside it whether the app is assisted or autonomous, the day's
ceiling, how many may work at once, and whether it is paused and why. It is
a studio page over the very same actions dev's Crew and Autonomy settings
already use (`src/actions/crew.ts`, `updateRepoSettings`) — same
same-origin check, same authorization, same errors; nothing here decides a
mutation a second way. _The rest of the settings_ — visibility, the
default branch, branch protection, labels, webhooks, environment
variables, deploy keys, danger — stays dev's, one link away
(`?mode=dev`), where the tab strip still has Crew and Autonomy of its own.

**The owner's facts and the public's.** What an app _is_ — its description,
whether it is live, its address, the look, _Open the app_, and how many
changes it has shipped — is the point of a public app and stays on the
page for anyone who can read the repository, signed in or not. What
running it _costs_ — every dollar figure, the day's ceiling and slot
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

**Whose name a row carries** is one rule, in one place — `voiceFor`
(`src/web/studio/voice.ts`), which the app's page, a run's own page and the
board all sign their rows with. An agent's name is _not_ a secret: a
change's own page and `/changes` name the agent that opened it to anyone
who can read the repository. "The crew" is a voice, not a redaction, and it
is chosen by **what the actor is** first: a person is named to every viewer
who can see the row at all, so one visitor reads one name for one change on
all three pages, avatar included; only an agent's own work — a run, a
change it opened, a tell it holds — reads as the crew's for a viewer who
cannot see the roster. Nothing here decides whether a row is visible.

**The terminal** is the same operator's door, so it sits beside the same
facts: a writer sees the exact `ssh …` command production answers to,
copyable, with the forge's host key fingerprint beside it, or one line
saying the terminal is off — no SSH listener on this forge, or this
app's `forge.json` declares no `tty` (`docs/APPS.md`, _A terminal for
every app_). A pull's own preview card shows its own command the same
way, since a preview answers to a different login than production's. A
reader sees none of this. Both surfaces call the one function that knows
the fact, `terminalFor` (`src/actions/apps.ts`), so the pull's card and
the studio page never carry two ideas of what the command is.

**Following** comes first when the app is a fork of another: one sentence on
where it stands against what it follows — in step, behind, ahead, or diverged
— and one thing to do about it. Behind, or diverged where git merges cleanly,
is **Take updates**, a click. Diverged where both sides changed the same file
is **Converge with the crew**: a builder merges the parent's branch, keeps
this app's direction where the two cannot both be kept, and the result comes
back as a change to look at, or lands on its own when the app runs on its
own. The words are the studio's; the mechanics are `docs/FOLLOWING.md`.

**The box** is the front door. A sentence becomes an issue — the first line
its title, the rest its body — and the routing decision hands it to a
builder: the builder with the least in flight, then by name. That is one
fixed-choice function (`crew/autonomy.ts`, `pickBuilder`), the place a
faster or wiser decider plugs in. The run starts on the crew's next tick,
and the page shows it waiting, then working.

**Nothing waits on you.** An autonomous app lands its own green changes
once `main` merges cleanly and the wall is clear (`docs/CONTRACT.md`). A
conflict sends its builder to bring the branch up to date; a red check past
the crew's tries parks the issue back on the map for a fresh plan rather
than handing it to you. The one thing that stops a change is the wall — a
contract loosened — and that shows on the change and in the audit, never
as a queue here. A repository paused at its ceiling says so on its own
card, with the way to settings. An assisted app's green change carries its
own **Ship** and **Not like this** on the change's page, and nowhere else.
Nothing here re-queues anything: a re-queue button is what an operator
presses instead of deciding.

## The three lists

`/:owner/:name/issues`, `/pulls` and `/runs` on an app, in the studio, are
_everything told_, _every change_ and _every run_ — dev's tabs with dev's
issue numbers, labels, milestones and branch names replaced by the same
five words the rest of the studio speaks. Each is a page of rows, newest
first: who has it (the assignee, the author, or who ran it), when it last
moved, its state as `wordBadge` draws it (`src/web/studio/words.ts`), and
one link — the row itself — to the tell, the change or the transcript.
`/:owner/:name/tells` and `/:owner/:name/changes` are the studio's own
nouns for the first two lists, and `/:owner/:name/tells/:number` and
`/:owner/:name/changes/:number` for one tell and one change — the same
handler each, the same authorization, the same `?word=` filter and paging,
not a second copy of any page; a viewer the studio does not apply to (dev
mode, `?mode=dev`, or a repository that is not an app) is sent on to
`/issues`, `/pulls`, `/issues/:number` or `/pulls/:number`, dev's own
address, rather than the studio's nouns ever growing a second,
dev-flavoured address of their own. It goes one way only: a dev URL asked
for in studio mode answers the studio's page where it stands, never a
redirect, so every link ever written to `/issues/7` keeps working and
`?mode=dev` on it is still the one click to dev's own. In studio mode the
studio's own links use the studio's nouns wherever a tell or a change is
linked — the three lists' rows, the app page's _now_,
a tell's dependencies and the change that closes it, a run's own tell, the
search box and the command palette — so a person is never handed two
addresses for one thing. The app page's own footer (`the map · everything
told · every change`, and _Every run_ above **Now**) and the repository
header's tabs (`Told`, `Changes`, in place of dev's `Issues`, `Pulls`) link
to `/tells` and `/changes`; dev's `Commits`/`Branches` stay dev's alone.
`/runs` has no second noun — the studio and dev share the one address
there. What a page _posts_ to never moves with the noun: ship, close,
comment and decide keep posting under `/issues/:number` and
`/pulls/:number`, which is what `form-action 'self'` and the same-origin
checks are written against.

_Look_ is spoken for by the five-word table above (a pull green and ready
for a person's own look) and by the picture card on one (`lookCard`,
docs/APPS.md, _The look_); the tab to this list, and the list itself, use
_change_ instead, so the word never means a third thing on the same page.

A row's word comes from `tellWord`, `pullWord` or `runWord` — the one place
each is decided, never re-derived here. `?word=told|working|look|shipped|
stopped` is a link at the top of each list, never a form, so a filtered
view has its own address to share; with no `word` the list shows what is
open and moving — told, working and look, never shipped or stopped, the
same split "Open" draws elsewhere. `waiting` and `planned` — a merged pull
production has not caught up to yet, or a run with nothing to show —
still read as _working_: still moving, not one of the five a list links to
on its own. Paging is the underlying list's own cursor, unchanged; a word
filter narrows the page it lands on rather than inventing a second scheme.
`?mode=dev` on any of the three is dev's list, exactly as it always has
been; a repository that is not an app renders dev's list here regardless
of mode, since there is no studio to switch to.

## A tell, on its own page

`/:owner/:name/issues/:number` — `/:owner/:name/tells/:number` in the
studio's own noun, the same page — on an app, in the studio, is a tell — one
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
than showing it as waiting forever. _Read the details_ is one link away,
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

`/:owner/:name/pulls/:n` — `/:owner/:name/changes/:n` in the studio's own
noun, the same page — on an app, in the studio, is the change itself —
never its diff. The title and the opening post in the author's own words,
who made it and when, the check in the studio's five words (`pullWord`,
`src/web/studio/words.ts`) with its deploy one click away, the preview's
state with the link that opens it (`previewCard`, the same card the aside
carries in dev), and the look at phone and desktop width when one has been
taken (`lookCard`, docs/APPS.md). Below that the same decision an ask card
offers — ship it, or say what is off — through the very same `mergePull`
and comment actions, and the conversation: read it, add to it. _Read the
code_ is one link away, `?mode=dev` on the same URL, landing on the diff
page exactly as it always has, deep links and all. Nothing here reads a
diff or a blob: the page costs a handful of small queries whatever the
change's size, unlike the page it links to.

## The asks

`/asks` (`asksPage`, `src/web/studio/asks_page.ts`) is the one screen for
"is everything fine?". It leads with one sentence — _All fine_ when nothing
asks the viewer, otherwise _N things need you_ — then the decision cards
(a pull the crew stopped on, a green pull waiting for a look, an app parked
at its ceiling), and, for a site admin only, one card per sentence of the
forge's health (`needs` in `/api/v1/health`). What counts as an ask is
defined once, in `src/web/studio/asks.ts`: the header's **Asks** count, the
page, the dashboard's _Needs you_ link and the phone notifier all read it,
so the numbers agree. It is server-rendered and every button is a form post,
so it works without JavaScript.

## The home

`/` in the studio: what is on you (issues and pulls a person assigned to
you), and your apps — each with
whether it is live, what the crew last did there, and a way in. That row is
a _shelf row_ (`src/web/studio/shelf.ts`): one function turns repositories
into rows, from grouped reads, so every page that lists apps lists them the
same way and the home only decides the card around them. **New app** is the
same form either way (`/apps/new`); once the sentence becomes a repository
it lands on the repository's home, `/:owner/:name` — in the studio the
app's own page, not this shelf; in dev the code, wearing the app strip.
Its first paint carries the flash saying where it's starting.
`/?mode=dev` is the repositories list, and — like
the toggle in the top bar — it switches this browser to dev from then on;
`/?mode=studio` switches it back, the same way.

**Apps** in the top bar and _All N apps_ on the home both land on `/apps`
(`src/web/pages/apps.ts`), which in the studio is the whole shelf — every
row the same `shelfRows` the home draws, never a second copy of them — with
how many there are and a filter for whether they are live, each a link
carrying `?live=1` rather than a form, and **New app** beside them.
`?mode=dev` on the same URL is dev's table of repositories, unchanged.

The home keeps itself current. _Your apps_ and _on you_ are each a live
region (`data-live`, `src/web/client.ts`): a deploy serving, a pull
opening, closing or merging, a run starting or ending, or an assignment
changing fetches that region again — the very same render that drew the
first paint, never a second copy of that markup — and swaps it in place,
so a card that is answered goes and a new one arrives without a reload.

### Live regions

A page with a script never reloads itself: the `meta refresh` some pages
carry is the no-script fallback, and the script removes it the moment it
can stream. Every live region listens to one `EventSource` (`/events`,
everything the viewer may see) and works like this:

- **An address of its own.** A region carries `data-live-src` — `/live/apps`
  and `/live/on-you` on the home, `<repo>/app/now` for _Now_ on the app
  page, `<repo>/app/state` for its head card — and an event fetches that
  address, not the page. The fragment answers with the same element, id
  and all, rendered by the same function as the page, with its icons
  inlined (`layout.fragment`). A region without an address shares one
  fetch of the page; that is the fallback, not the design.
- **Nothing painted that did not change.** A fragment's `etag` is a hash of
  its bytes; the client sends it back as `if-none-match` and an unchanged
  region is a 304 with no body. The same tag is stamped on the fragment's
  first element (`data-etag`), because a proxy may drop the header —
  Cloudflare strips `etag` from HTML. When bytes do arrive, two renders
  that differ only in a relative time ("3m ago") are the same region.
- **One fetch per burst.** Events within a beat of each other cost one
  fetch per address, never more often than every second and a half; a
  hidden tab fetches nothing and catches up on the first look back.
- **Never out from under a hand.** A region holding a focused input, or a
  card whose post is still in flight (`data-busy`), is left alone until
  the next event.

Run logs and the crew's transcript stream line by line over their own
`?follow=1` answers; they are the streamed part of a page, not a region.

Signed out, `/` is a stranger's front door in either mode — the studio's
door, never a git pitch (`studioDoor` in `studio/home.ts`). It is a shelf of
the public apps a signed-out reader can see, the live ones first — name, one
line of description, live state, and production's own picture, linking
straight to the app — read from the apps themselves (`listPublicApps`), so
no number of plain repositories crowds an app off it. Sign in and Create an
account stay one click away, with the forge's ssh command beneath them when
the terminal is on. A forge with nothing public up yet — most people's first
visit — shows the same door with an empty shelf that says so. `/?mode=dev`
answers a stranger with the same door; the repositories are a signed-in
person's dev home.

## The board

`/board` is what is happening now across your apps, as a wall for a second monitor
(**Focus** on that card opens it): no top bar, dark unless you chose a
theme, four regions that fill the window. **Working now** is one card per
run in flight — who, which app, what it is on, why, how long, what it has
cost — ordered by when it started. **Landed** is the last dozen shipped
changes across your apps, each with the app's production look on a phone.
**Decided** is the last dozen entries in the decision ledger: which issue
next, ship or show, try again — the answer, how sure the decider was, and
what came of it. **Today** is one row per app that runs on its own: spend
against the ceiling, runs, shipped, and whether it is paused — plus any
other app the crew spent on this week — and beneath it the efficiency
signal: spend per shipped change over the last 7 days (the usage ledger's
`cost_usd` ÷ pulls merged, `core/efficiency.ts`, every app in one grouped
query), or "$4.10 spent, nothing shipped" when there is no ratio. A site
admin also gets a strip of the subscriptions above the regions: each
account's 5-hour and weekly window — used, left, resets — in the words
`windowWords` (`studio/words.ts`) gives them, with _inferred_ beside every
figure the provider did not say (`core/standing.ts`; all the accounts in
three statements, `standings`). Every region
is live — it swaps itself when a matching event lands, and the dot in the
corner says whether the stream is connected. `?apps=a,b` narrows it to some
apps. Keys: `f` fullscreen, `1`–`4` one region full-bleed, `0` all.
`?wall` is its one wall mode, for a screen across the room that nobody
touches: the same regions in larger type, no key hints, no pointer. The
old big view folded into it — `/big` and every address it had land on
`/board?wall`, keeping `?app=owner/name` as the board's `?apps=`.
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
