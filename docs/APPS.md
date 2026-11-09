# Apps, runs, and the crew

This document defines apps, previews and runs, and lists the rules the forge
enforces for them. It is for people who build on the forge and for developers
who change it.

An **app** is a repository that the forge runs on its own port. Each app has a
production instance and a preview for every open pull. The **crew** is the set
of AI agents that work on the app. Apps run contained only on hosts with
bubblewrap and user namespaces. macOS has neither, so apps there run
uncontained. [`ARCHITECTURE.md`](ARCHITECTURE.md) describes the foundation.

## The app model

The model is similar to Vercel's: you have apps, apps have previews, and git
decides what is production and protects it. There is one difference. The person
using an app does not need to be a developer. They need to know what an app is
and to keep production data and preview data apart. Developers and agents use
the same primitives, so there is no second system.

## Making an app, and what it does

A repository that runs. Press **New app**, give it a name and — if you like —
a sentence about what it should do. Seconds later it is serving at
`http://<name>.<your forge's host>` from a small, real app (notes in a SQLite
file), and if you named an agent, the sentence became issue #1, assigned.

Under the box, four starter sentences are plain links (no script):
`/apps/new?description=…` fills the box with that text (plain text up to
200 characters, anything else is ignored; always escaped), and
`&owner=` keeps the chosen owner. The list is `src/web/pages/apps-starters.ts`.

- **Private egress is a site admin's yes.** An app reaches a private
  destination (a tailnet or LAN `host:port`) only when `forge.json` `egress`
  names it exactly and a site admin has granted it: on the
  app's settings page, or in the terminal (About `I`, then `e`, `g`
  to grant, `x` to revoke). The rule is under "Rules that are mechanical" below.
- **Egress connections are bounded.** The proxy closes the upstream socket
  the moment the cell side closes, errors or stops, and the other way round.
  An app holds at most 8 open connections to one destination (the ninth
  gets a `429`, logged), and a connection that moves no bytes, either way, for 5 min is
  cut, so a tunnel quiet for longer than that (a websocket or SSE stream with
  very long gaps) needs a keepalive. Open connections per app and
  destination, with the bytes moved, are on the Capacity page
  (`/settings/capacity`, admins) and in the terminal: About `I`, then `c`
  (site admins).
- **Production is the default branch.** The only way code reaches it is that
  branch moving, and an agent cannot move it: the crew proposes through
  pulls, a person merges.
- **Every open pull gets a preview** at `<name>--<pull number>.<host>`,
  redeployed on each push and gone when the pull closes. Its data starts as
  a copy of production's — copy-on-write where the filesystem can — and
  never writes back. Merging moves code and touches no data.
- **A preview is held to the website specification, report-only.** Once it is
  live, `webspec()` runs over the `app.looks` paths of its `forge.json`. The pull
  page shows the result under the Checks line as **Website spec: N findings
  (report only)**; open it for one row per finding and its
  specification.website section. Findings the edge owns are counted apart
  (`, M the edge owns`). The terminal's pull screen ends its checks row with the
  same words. Nothing here fails a deploy or the check; see
  [`docs/WEBSPEC-PREVIEWS.md`](WEBSPEC-PREVIEWS.md).
- **A streamed page gets the pill too.** An HTML answer with no
  `Content-Length` is read up to 4 MiB for at most 100 ms, and only while its
  first chunk starts like markup; if it ends in that window it gets the pill
  like a sized page. Otherwise what was read is sent first and the rest of the
  stream follows unchanged. The cost: a streamed page that is still going
  waits up to those 100 ms before its first byte reaches the browser, so a slow
  server-rendered page paints up to 100 ms later (a page sent with a
  `Content-Length`, or one that starts with something other than markup, does
  not wait). Event streams and WebSockets are untouched.
- **A signed-in note needs the panel's one-use proof (#5612).** The grant
  cookie alone no longer makes a note `@name`: the forge puts a one-use token in
  the panel's script tag on a signed-in page load, the panel sends it as
  `x-forge-proof` and each answer carries the next. Without it, a reused one or
  one for another grant or host, the sender is a visitor and `admin` is false.
  This stops an app's code that merely holds the cookie (a `fetch` from its
  page). It does **not** stop app code that runs in the same page and watches
  for the tag or patches `fetch` before the panel runs: the token reaches the
  panel through the page, so that code can read it. Closing that needs the
  panel in a cross-origin frame, which is not built. If a call fails the panel
  asks for a reload, since the chain is then spent.
- **The forge button is a feedback door (#4758).** One tap opens *Tell the
  builders*: a text box and Send, no account. The note is posted to the app's
  own host (`POST /__forge/note`, same-origin only) and filed as an issue on
  its repository, labelled `from-app`, with the page, the viewport and the time,
  in the owner's name and with the sender's words inside one fence. A visitor
  is an anonymous `visitor-xxxxxx` (an HttpOnly cookie); a signed-in person is
  `@name`. Moderation: 3 notes a minute per sender, 6 per source address, 20 per
  app, a word filter, and the owner's hide or ban, which closes the issue and, for
  `ban`, refuses that sender. `GET /__forge/notes` gives the sender's own notes with a live
  status (queued, being built by a member, shipped on a date), polled every 15 s
  while the panel is open; a public app's note links to its issue. Left out: the
  optional screenshot and a version name in "shipped".
  From the terminal, a repository screen that is an app has two palette rows
  (`:`): *Tell the builders* sends a note as you, and *Notes from the app*
  lists yours with their status; the repository's admin sees every sender's and
  may hide a note, ban its sender, list the banned senders (*Banned senders*)
  and unban one. The gating is the page's: a guest or a
  non-reader sees nothing, and a repository that is not an app has no rows.
  Who may write: anyone on a public app, but a private app, and any sealed
  pull's preview, take notes only from a person the app admits (the condition
  `/__forge/measure` uses); a stranger is refused with a 404 before anything is
  filed. Moderation
  happens on the forge, not on the app: the app host answers only
  `POST /__forge/note` and `GET /__forge/notes`, and `/__forge/note/moderate` is
  a 404 there, because the app's own code (or a preview's) could call it
  same-origin with a visiting admin's cookie. The terminal screen above and the
  app's studio page are the owner's tools: the page lists the latest notes
  (sender, words, page, when) for those who may admin the repository, each with
  Hide and Ban sender, and every banned sender once with Unban, posting to
  `POST /:owner/:name/app/notes` on the forge's origin (`web/studio/notes.ts`). The same moderation is an API for
  agents and scripts (`http/api/app_notes.ts`): `GET /api/v1/repos/:owner/:name/app/notes`
  answers `{ notes, banned }`, and `POST …/app/notes/:id/hide`, `…/ban` and
  `…/unban` each answer the note. They need an `rw` token (or a same-origin
  session) and admin rights on the repository; anyone else gets `forbidden`.
  Limits count the socket's client (`http/peer.ts`, with its trusted-proxy
  rule), never a header the client wrote, and all three are checked before any
  is spent. The request body is read only up to 16 KB. The issue says its text
  is untrusted data, and the crew's brief says so for any `from-app` issue.
  A title always opens with `From the app: ` (`saysFromApp`), the label is made
  before the issue, and a failed labelling closes the issue and refuses the note.
  Only a note closed as done reads "Shipped"; the other reasons say what they are.
  Beyond the per-minute limits an app takes 30 notes an hour and 100 a day.
  The script grew to about 15 KB (cached, immutable); the notes are polled only
  while the panel is open.
- **A note may carry a picture of the page (#4820).** The panel has an
  unticked *Include a picture of this page* box; nothing is captured unless it
  is ticked. The picture is taken in the browser with no dependency: the
  visible page is cloned with its computed styles inlined, drawn through an SVG
  `foreignObject` onto a canvas and encoded as PNG (JPEG if over 2 MB). Images
  and fonts loaded from other origins do not travel with it, and a browser that
  refuses to encode it sends the note without, saying so. The note is filed
  first; the picture follows as `POST /__forge/note/picture?note=<id>` (raw
  bytes, same-origin, the note's own sender only, one per note). The server
  reads at most 2 MB, accepts only PNG or JPEG by their first bytes, never by
  the declared type, and keeps the file under `FORGE_APP_DATA/note-pictures`.
  The issue page shows it from `/:owner/:name/issues/:n/picture`, which answers
  exactly those who can read the issue (a sealed report gives the not-found).
- **The forge pill acts.** The pill the proxy adds to an app's pages
  (`"toolbar": false` in `forge.json` turns it off; to write it in, the proxy asks the app for the page uncompressed, so a page that carries the pill goes out without gzip) links to a forge page,
  `/:owner/:name/toolbar?env=production|pull-N`, opened in a tab of its own: the
  pill posts nothing and reads nothing of the app's page, and every action is a
  same-origin form on the forge. On a preview, everyone who may see the pull sees what it changed (files, +added, −removed, linked to its Files tab) and where its latest check stands (linked to the run); the totals are left out when git cannot give them. Signed out, the page is where you are and Home.
  Signed in it shows the live agent run on this app or preview, linked to its
  run page (read once when the page opens; runs on work you may not see, such as
  a sealed report, are left out); *Report this page* / *Comment on this pull*,
  previewed first, then a receipt; *Tell the crew* for those who may direct it
  (the one `/:owner/:name/tell`); and *Make it yours* for everyone who cannot
  write the app. A production comment opens an issue carrying the page address;
  a preview comment goes on its pull. From a terminal or an agent the same
  actions are, in the SSH terminal, rows of the palette on a repository
  screen: *Working now* (one row per running agent run with its minutes, choosing
  one opens the run's log; a run on work you may not see is left out),
  *Tell the crew*, *Report a problem* (one text, an issue
  titled by its first line, through `openIssueThrough`) and *Make it yours*
  (for those who cannot write the repository: `Y` on the repository screen, or the palette row, asks for a name, defaulting to the original's, and a visibility, `tab` to switch, then shows the plan and copies only after a confirm, and the copy opens), *Labels* (its labels with their hex; an admin presses `n`, types a name and six hex digits, `bug d73a4a`, the `#` optional, and the list shows the new label at once — `e` on a label opens the same form prefilled with its name and colour, and saving renames or recolours it (a refusal shows on the form and keeps what was typed); `d` on a label asks first, naming it, with Keep the default, then deletes it; a reader is offered none of `n`, `e` or `d`), and *Vision*
  (docs/VISION.md on the default branch: the purpose, each pillar numbered,
  the rules, through the one read MCP `vision` makes; when there is none the
  terminal says so in one line of its own, where MCP answers an empty `order`;
  admins also see, under the rules, the open direction issue (`#N title`) and
  its parts, read as MCP `vision` reads `directionParts`, and Enter opens the
  issue; with no open direction issue nothing extra is drawn); a pull is
  commented on from its own screen. Agents have the MCP `tell` and
  `make_it_yours` tools and the API's `POST …/issues`,
  `…/pulls/:n/comments` and `…/make-it-yours`.
- **A run has a budget** (`src/kernel/budgets.ts`): a check past `gate`
  (60 min) or a reviewer's run past `review` (10 min) is killed with
  `budget: <what> took <n> min, limit <m>`, queued again once, and failed
  the second time, which the vitals carry as a need for a day. `gate` is 60
  min because this repository's own gate takes 18–25 min alone and 45 beside
  another check; it comes down when the gate does. A check waiting in the lane
  past `laneWait` (10 min) or a run silent past `heartbeat` (3 min) turns the
  health degraded with one sentence naming the cause ("22 checks wait behind
  one lane; the oldest since 04:13; the lane runs #1212 for 31 min (limit
  60)"). The sentinel files each such breach at once, not once per tick:
  labelled P0 Trust and assigned to the sentinel, whose run the dispatcher
  queues on the assignment.
- **Every deploy is a run**, and the run is the check on the pull. Turn on
  **require checks** and a pull cannot merge until its head is green.
- **A production deploy records the merged pulls it carries**: one `git
  rev-list` of the deployed commit when the run finishes. The run page says
  "Carries #3, #5" and `GET /api/v1/repos/:owner/:name/runs/:id` has `carries`.
  In the terminal, open a repository and press `d` for its production deploys
  (each with what it carries), `enter` for the log, `r` to refresh. A signed-in
  reader also sees `Production: <url>` and, when a pull's preview is up or
  asleep, `Newest preview: #N <title> <url>` — the pill's other side, same
  gate; a guest sees neither. Under the deploys, anyone who may read the
  repository sees a **Previews** group: one row per open pull with a preview,
  `#N <title> · <state> · <url>`, the state in the studio's words (`live`,
  `not up`, `starting`…) from the one runtime read the studio's list makes.
  `j` past the last deploy moves into it and `k` from its first row back;
  `enter` (or a second click) on a preview opens that pull. An app with none
  says `No previews.`. A writer presses `p` there to probe the running app's
  doors as nobody, a user and an admin, read-only — one line per door with
  its status and `ok` or what was wrong, `r` to knock again; the result is
  kept and the mismatch issue opened or closed as for MCP `probe`. On a
  private app, `m` lists the people it names; a writer who is a person
  presses `a` to let someone in by username or `d` to let the selected one
  out, each shown as a plan and applied after a confirm, as MCP
  `app_members` does. An agent is not offered `m`; the list is its writers'
  to choose.
- A **private** app answers only to someone the forge has vouched for
  (`canRead` on the repository, then a signed grant); a public one to anyone.
  A scripted caller needs no browser: `Authorization: Bearer <token>` on the app's host
  admits a token whose person may enter the app (a run's token only on its own
  repository), and the header is stripped before the app sees the request. A
  reader who may not enter is told so in the 404; anyone else gets the plain one.
- **Every app has a terminal.** `ssh -p 2222 <name>@<forge>` runs the app's
  `tty` command from `forge.json` on a real pty over the environment's own
  data; `<name>--<pull>@<forge>` opens a preview's. The scaffold ships one.
- **A new app starts trustworthy.** The scaffold's door asks the app's
  contract before a body is read, every change and refused change is an
  audit row, the API describes itself at `/openapi.json`, `/healthz` says
  up, and the look is design tokens, light and dark, with no colour spelled
  out anywhere else ([below](#what-a-new-app-starts-as)).

The repository says how it runs in `forge.json` (`run`, and optionally
`install`, `test`, `health`, `ready`); a `package.json` with a `start` script
is enough on its own. The forge hands the process `PORT`, `FORGE_APP_DATA`
(this environment's directory — keep state there), `FORGE_APP_ENV`,
`FORGE_APP_URL` and `FORGE_APP_COMMIT`, and nothing from its own
environment. Browsers resolve `*.localhost` to loopback, so a laptop forge
needs no DNS at all; elsewhere point a wildcard at it and set
`FORGE_APP_DOMAIN`.

**Move the pill.** If the pill covers something of the app's, drag it (mouse or
touch) and it snaps to the nearest corner on release; with the pill focused, the
arrow keys walk it from corner to corner. The corner is kept in the browser's
`localStorage` for that app's host (bottom-right until then), and the panel opens
toward the inside of the screen, bounded to it at phone width. The script stays
under a 10 KB budget (a test holds it), since it loads on every app page.

The forge pill on an app's pages says where you are: its accessible name reads
`notes, production` or `notes, preview of pull #7`, and pressing it opens a
panel with the app, the environment, and a link home. The pull's title is shown
only to people who may read the pull. A tap outside the open panel, or Escape,
closes it. When a crew run is working on the app (production) or on the preview's
pull, the panel also says `scout is working on this` and links the run; it asks
`/__forge/crew` once as the pill loads, answers only a signed-in person who may
read the repository (and, for a run on a sealed issue, that issue), and shows
nothing when the crew is idle.

**When the pill is not shown** (an app whose own policy refuses foreign
scripts), `/__forge/` on the app's host is the way back: a small page from the
forge, never the app, with no script, saying the app and where you are
(`production` or `preview of pull #N`) and linking Home, the repository and *Make it yours*
(`<repo>/make-it-yours`; both only to who may read the repository, who also
get the "more pulls" line linked to `<repo>/pulls`) and *Tell the crew* (the same link `/__forge/crew` gives; signed
out it offers sign in). On a preview it also links *The live app* (the production
address, so one tap compares the pull with production), only to who may read the
repository, as *What changed* is; production's door has no such link. In the
open-pulls list the preview's own pull is plain text marked "(this preview)"
instead of a link back to itself. It also says what is serving, read from the deploy
record (no git): production shows the newest release and the three before it
(a redeploy of the same commit is not another release), a preview shows its
pull and the commit it last served, or "not deployed yet". A viewer who cannot
read the repository sees only the time, never a sha. The read is the `serving`
Server-Timing phase. The prefix was already the forge's, so an app's own
`/__forge/` path is not reachable.

**Reading a slow app's Server-Timing.** A response the proxy relays keeps the
app's own entries (`db`, `app`, …) and gains the forge's, each `forge-` named
and in milliseconds only: `forge-route` (finding the target and its grant:
the sum of `forge-lookup`, the server finding the app by its host,
`forge-state`, the doors and the environment's state, and `forge-session`, the
grant read), `forge-wake` (waiting for a sleeping or starting environment; 0
when none), `forge-upstream` and `forge-ttfb` (the same wait, until the app's
headers: `fetch` reports nothing of its connection, so the socket's opening
is inside it), `forge-body` (reading a page whole for the pill) and
`forge-rewrite` (pill injection with that read, when it ran). Big `forge-wake`
is a cold start, big `forge-ttfb` is the app or its listener, big `forge-body`
is an app slow to finish its page; if all are small, the time went before the
request reached the forge. The forge opens no second socket to time the
connect: it would take a backlog slot in the very case it is meant to find.
The "app stopped answering" page carries `route`, `wake` and `upstream` too;
the forge's own `/__forge/*` pages and the WebSocket upgrade name no forge-
phases. A refused answer (sign in, not found, not running) names none either:
the wake runs before the door is asked, so its time would tell a caller who may
not read the app whether it was asleep. The proxy has one writer for these
(`withPhases` over `notePhase`), which appends to the app's header.

**Tell the crew from the pill.** Signed in as someone who may direct the crew,
the panel also offers *Tell the crew* (`/__forge/crew` adds a `tell` link, only
for them; signed out there is no action). It opens the forge's own
`/:owner/:name/tell?page=<address>&pull=<n>` in a new tab, so the POST is the
forge's same-origin, CSRF-checked form and the app's origin can never send one.
It is the same `tell()` as every door; `page` (an http(s) address) and `pull`
(a number, on a preview) are checked again on send and written into the tell
as the *Where this was told from* block. A receipt links the issue it opened; a
refused tell returns to the box with the words, page and pull kept. The MCP
`tell` takes the same through `context: { page, pull, run, commit, said }`, and
the terminal's palette has *Tell the crew from a page*, which asks for the
page, the pull (optional) and the line, through the same `parseContext` and
`contextNote`.

With a sentence and **Pick for me**, the sentence becomes a plan before the
page comes back: `src/crew/plan.ts` makes one non-interactive call to
`claude` — the quickest model, a fixed JSON shape, at most 3 seconds — for a
short checklist and a crew pick, so issue #1 opens as a checklist already
assigned to whoever the plan named, instead of a paragraph and a dropdown.
It costs one small model call per app made this way (a few tenths of a
cent), never blocks the repository or the app starting, and a bad or slow
answer is the same as none: no pick, no checklist, exactly what naming an
agent yourself already does. `FORGE_APP_PLAN=0` turns it off; so does having
no `claude` on `PATH` — either way **Pick for me** stops being offered and
`New app` behaves exactly as it did before this existed.

## Vocabulary

- **App** — a repository that runs. A repository becomes an app explicitly
  (`New app`, or `Run as an app` on an existing one), the same way a
  repository is mirrored explicitly: a choice you can see and reverse. An
  app has a **slug**, the label its hostnames are built from.
- **Environment** — one place an app runs. `production` is the default
  branch. A **preview** is one open pull. Every environment owns a data
  directory, and nothing else does.
- **Deployment** — an environment at one commit: a checkout, a process, a
  port, a log. An environment routes to its _current_ deployment; a newer
  one takes over only once it answers.
- **Run** — a durable record of work the forge did on a commit. A `deploy`
  run installs, builds, tests, starts and waits for the app to answer. An
  `agent` run is an agent working on an issue or a pull. Runs are the
  **checks** on a pull.
- **Agent** — an account of kind `agent`. No password, no session; it acts
  only through tokens the forge mints for a run and destroys after it. It
  is a user in every other respect: it owns nothing you did not give it, it
  is granted access the way a person is (collaborator or team), and its
  name appears on the pull it opened.
- **Crew** — the agents with write access to a repository.

## Rules that are mechanical

Each rule below is enforced in a code path with a test that tries to get
around it. None is advisory.

1. **Production is the default branch, and agents cannot move it.** The only
   way code reaches production is the default branch moving. The crew
   works from forks: being on a repository's crew grants an agent read and
   the right to be assigned, nothing more, so the repository itself takes
   no push from it at all. Its branch lives in its own fork of the
   repository, made on first use, and the pull proposes it back;
   `mergePull` refuses an agent actor. An agent proposes; a person lands.
   (A merge gate that lands on its own once a review and the checks agree
   is a setting to add, not a rule to loosen.) Two corollaries keep an
   agent from starting a chain: an agent cannot assign anyone (assigning an
   agent is what spends money, and only a person may), and an agent cannot
   create a repository (it owns nothing it was not given; it may fork to
   contribute). A reviewer on the crew may still pass a verdict — request
   changes, approve — since a verdict gates nothing an agent could do.
   A person's pull from a branch of the repository itself — the owner's
   or a steward's fix — is a normal pull: its pushes move its head and run
   its check, review and gate again, and it lands through the queue. No
   builder is sent to it, since none can push that branch; changes asked
   for on it go back to its author, and the crew never parks it
   (`crew/authors_pull.ts`, #7572).
2. **A preview lives exactly as long as its pull is open.** Opened: deployed.
   Pushed: redeployed at the new head. Closed or merged: stopped, and its
   data deleted. There is no orphan state; the sweep on boot rebuilds the
   set of previews from the set of open pulls.
   A pull from someone who cannot write the repository is the exception:
   its preview and its check run nothing until a person who can write
   approves that exact head, and each new push waits for a new approval
   (`core/pull_trust.ts`). A writer's own fork, and the crew's, run as
   before; an approval by the crew does not count.
3. **Preview data is a copy, never a window.** When a preview is created its
   data directory is cloned from production's at that moment (copy-on-write
   where the filesystem offers it — APFS, XFS, btrfs — a plain copy
   otherwise, and `empty` is a per-app choice). A preview process is handed
   its own `FORGE_APP_DATA` and nothing that names production's. Merging a
   pull moves code; it never touches data. A copy the build cannot read —
   its process exits before it ever answers, most often a migration on
   `main` the pull's commit predates — is tried exactly once more on an
   empty data directory before the deploy is failed; production is never
   seeded from a copy, so this never applies to it.
4. **A deployment is a check.** Every deploy is a run; the run's state is
   what the pull shows. With `require_checks` on, `mergePull` refuses
   `checks_required` until the head's deploy run is `ok`, read live inside
   the merge — never from a status a caller computed earlier. Install still
   comes first, but `test` and `start` run side by side: the environment is
   swapped in and serving the moment the app answers, and the run stays
   `running` — checking, not blocking — until `test` finishes and decides
   `ok` or `failed`. A deployment that answers is what was asked for; the
   suite going green is confirmed a few seconds later, not stood in front
   of the door. That instant is recorded, not just logged: the run's
   `servingAt` is stamped once, at the swap-in, distinct from `startedAt`
   (the deploy's own start) and `finishedAt` (which waits on `test`
   beside it) — so how long a change took to reach its preview is a
   number the forge can read back, not a line buried in the log. A page
   words that number from `createdAt`, the instant the push created the
   run, because the deploy may have waited on the concurrency gate for a
   permit first: `servedPhrase` (`web/ui.ts`) says `6.1s after the push ·
2.4s queued` and is the only place it is worded. The deploy's own log
   line stays measured from `startedAt` and says `after the deploy
started`; a deploy no push asked for — a redeploy someone pressed, a
   boot reconcile — is worded the same way and never claims a push.
   Where that time went is in the log too, step by step
   (`apps/timing.ts`): a `timing:` line before the process starts splits
   the wait for a permit (`turn`), reading the manifest, the checkout, the
   data and the setup, and one after it answers says how long the process
   took and when it first said anything. A restart brings every app's
   production back before any preview, and a production deploy waiting
   for a permit goes ahead of the previews waiting for one.
5. **A private app answers only to someone the forge vouches for.** An app's
   `access` is `public` or `private` (defaulting to the repository's
   visibility), and it is set apart from the repository's own: the code can
   be private while the app is public, or the other way round. A private
   environment sets no cookie of its own; a person arriving by its link is
   sent to the forge to sign in, which checks `canEnterApp` — the
   repository's writers, its crew, and the people the app names (its
   settings' **Who may enter**, `app_members` over MCP), never everyone who
   can read it — and
   returns them with a signed, short-lived grant for the page they wanted;
   the proxy asks the same question again on every request, so a grant
   stops working the moment its holder may no longer enter. Anyone else,
   and anything that is not a person navigating, gets the forge's own "not
   found". Guessing the hostname yields the same. Previews follow the app;
   the terminal stays its writers' and crew's. Making the repository public
   changes nobody's way in. A person the app names enters it and its
   previews and gets nothing else: no code of a private repository, no
   crew, no settings, no owner facts. What the app says about itself
   follows the same rule: its environments' state and errors (`envsFor`),
   its runs and their logs (`mayReadRuns`) and its run and serving events
   reach only those who may enter it.
   On any repository, public too, a run's **log** (the agent's
   transcript, a deploy's output) is read only by its writers and crew
   (`mayReadRunLog`); a stranger reads the run and its summary, not the
   log, on the page, the API and the live tails (#1075). Check runs share
   the rule: on a public repository the author of a pull from outside it
   reads a failed check's summary, not its output.
6. **A run's credential dies with the run.** An agent run gets a token
   scoped `rw` (no settings, no tokens, no administration) with an expiry,
   and the token is deleted when the run ends however it ends. It never
   appears in argv or a URL; git receives it through `http.extraHeader`,
   the same channel origins and the local client use.
7. **Runs are bounded.** Every run has a spend budget and a wall-clock
   limit. A pull gets a fixed number of automatic follow-up runs (a failed
   check, a request for changes) before the forge stops and says so; a
   person speaking on the pull resets the count. Nothing loops unattended.
8. **A child process inherits nothing it was not handed.** The forge's own
   environment holds secrets (an API key, an OAuth client secret). App and
   agent processes are started with an explicit environment — `PATH`,
   `HOME`, a locale, and the variables this document names — never the
   forge's.
9. **Repository code runs in a cell of its own.** An app, its previews,
   its terminal, and every install, test and check step run inside
   bubblewrap (`apps/contain.ts`), the tool that already holds the crew's
   shell. In a cell the machine is read-only; the forge's data directory
   and home are empty; `/tmp` is the cell's own; the only writable places
   are its own checkout, its environment's data and a home kept beside it.
   It has a pid namespace of its own, so no other process's environment or
   memory is visible, and a network namespace of its own with loopback and
   nothing else: the way out is the forge's proxy (`apps/egress.ts`), which
   reaches the forge and the hosts `forge.json` declares in `egress` (on
   ports 80 and 443, unless an entry names its port), and refuses anything
   else with a 403 that names the host and port. A declared name that
   resolves to a private, loopback or link-local address (the cluster, the
   node's metadata service, another pod) is refused too. Every mount that
   may carry a secret is empty inside: `/run/secrets`, `/var/run/secrets`,
   and every tmpfs the machine mounts outside `/dev`, `/proc` and `/sys`
   (how Kubernetes mounts a secret or a service-account token) — and a pod
   that runs the forge should set `automountServiceAccountToken: false`
   all the same, since the forge never talks to the cluster. Inside
   Kubernetes a cell goes further and sees an allow-list of mounts: none
   of the pod's but the root, its own /dev, /proc and /sys,
   `/etc/hosts`, `/etc/hostname`, `/etc/resolv.conf`, and the mounts the
   runtime and its tools live on — so a ConfigMap, hostPath, PVC or CSI
   volume mounted for the forge is empty inside. Elsewhere (a developer's
   machine, whose system is itself mounts: `/nix/store`, a home) the rule
   is the machine's mounts minus the secret-bearing ones above.
   `FORGE_CELL_MOUNTS=allow-list|deny-list` chooses either, and
   `FORGE_CELL_MOUNTS_KEEP` (`:`-separated) names a read-only system mount
   the allow-list must keep. Memory, CPU
   (averaged over 30 seconds) and disk are watched from outside; a cell
   over a limit is stopped, and the reason is the step's error or the
   app's last log line. Where the host cannot hold a cell (no bubblewrap,
   no user namespaces — macOS), the code runs as before and every deploy
   and check says so on its run page: "Uncontained", with the reason.

## The golden path

What a person sees, in order:

1. **New app.** A sentence about what it should do — that's the one thing
   that's required. The forge derives a name from it (shown, editable,
   before you submit) unless you set one yourself, creates the repository
   with a small working app in it, makes it an app, and starts production.
   Seconds later there is a URL. The sentence becomes the first issue,
   assigned to an agent on the crew, and the agent starts.
2. **A pull appears**, opened by the agent, with a preview. Open the preview
   (a link, or a QR code from a phone), use it. Leave feedback as review
   comments and a verdict. Request changes and the agent picks it up in the
   background; the preview updates when it pushes.
3. **Approve, merge.** Production redeploys from the default branch. The
   production data directory is untouched — the notes you took, the rows
   your app wrote, are all still there. The preview and its copied data are
   gone.
4. **Drop in whenever.** The dashboard lists apps with what is running, and
   **Needs you** — pulls waiting on a review — is the inbox. Everything
   else runs without you.

Nothing above required a terminal. Everything above is also reachable from
one, and from the JSON API, because each step is an action.

`POST /api/v1/apps` takes `name`, `owner`, `description`, `visibility`, `agent`
and `pick`: `pick: true` turns the description into a checklist and lets the
plan pick the agent (ignored when `agent` is given or there is no
description). The 201 answer carries `plan: {agent, summary, confidence}` when
a pick happened and `plan: null` otherwise, planning being unavailable included.

## How an app is declared

The repository says how to run itself, in `forge.json` at its root:

```json
{
  "app": {
    "run": "bun run src/server.ts",
    "install": "bun install",
    "test": "bun test",
    "health": "/",
    "ready": 30,
    "tty": "bun run src/tty.ts",
    "looks": ["/", "/board"]
  }
}
```

Only `run` is required, and even it defaults: a `package.json` with a `start`
script is enough. `install` defaults to `bun install` when a `package.json`
exists and to nothing otherwise; `test` defaults to nothing; `health` is the
path polled until it answers; `ready` is the number of seconds to wait for
that before the deploy fails; `tty` is the app's terminal interface (below);
`looks` names the pages worth a picture (below), and defaults to `["/"]`. The
file is read from the commit being deployed, never from the database — a
pull that changes how the app runs is previewed the way it will run.

`toolbar`, at the top level, is `true` unless you set it to `false`. The
forge adds one `<script>` tag to the HTML pages your app serves (before
`</body>`, or at the end): a small pill in the bottom-right corner, collapsed
until pressed, drawn in a shadow root so it never touches your styles. The
script comes from the forge's own origin, immutable-cached, with no inline
code; a `Content-Security-Policy` that forbids it just leaves the pill out.
Only `text/html` responses the app sends uncompressed with a `Content-Length`
(up to 4 MiB) are rewritten; JSON, images, compressed or chunked HTML and
`HEAD` requests pass through byte for byte. `"toolbar": false` keeps it out.

`adapter`, at the top level, says the app is an adapter the forge pulls
from on a schedule (#437): `{ "adapter": { "schedule": { "every": 900 } } }`.
`every` is whole seconds, 60 to 86400. `source` (the system's name and the
hosts it reads, each also in `egress`) and `config` (the settings it reads,
by environment variable) are optional; any other key, at any level, fails
the manifest with the field named (`src/apps/adapter.ts`). Absent, the app is
not an adapter. The contract is [`docs/ADAPTERS.md`](ADAPTERS.md).

Two more fields say what the app's code may use (rule 9):

```json
{
  "egress": ["api.stripe.com", "*.cdn.example.com"],
  "app": { "run": "bun run src/server.ts", "limits": { "memory": 1024, "cpus": 1, "disk": 2048 } },
  "check": { "run": "bun test", "limits": { "memory": 4096 } }
}
```

`egress`, at the top level, is shared by the app and its check: exact host
names, or `*.` for every name below one, at most 32, each reachable on 80
and 443 — `db.example.com:5432` names one other port instead. Without it an app
reaches the forge and nothing else; install, test and check steps also
reach `registry.npmjs.org`. `limits` (MiB, cores, MiB) default to 512 MiB,
1 core and 1 GiB for an app and 2 GiB, 2 cores and 4 GiB for a step, and
are capped by the machine (`FORGE_CELL_MEMORY_MAX_MIB`, default 4096; the
number of cores; `FORGE_CELL_DISK_MAX_MIB`, default 16384). A cell's `/tmp`
holds at most 256 MiB.

Memory is held twice. The watch reads every cell's resident memory once a
second and stops one over its limit. Where the forge holds a delegated
cgroup v2 (`apps/cgroup.ts`), the kernel holds it as well: each cell runs
in `<R>/cells/c<n>-<pid>` with `memory.max` set to its limit,
`memory.swap.max` 0 and `memory.oom.group` 1, and the forge moves itself
to `<R>/forge`. A check that allocates past its cap faster than a tick is
then OOM-killed alone (`check stopped: it reached its 8192 MiB memory cap,
and the kernel killed it`), never the forge or the other checks (#2410).
`R` is `/sys/fs/cgroup` when the forge is at its container's cgroup
namespace root, or `FORGE_CELL_CGROUP` (a path, or `off`). The cgroup has to
be writable by the forge's user. A container's `/sys/fs/cgroup` is
read-only by default, so the operator delegates it, for example as a
writable cgroup mount owned by the forge's uid. Without that, cells are
watched only. /system says which holds the cap, and why, and shows each
cell's memory beside its cap.

The forge's own process outranks what it starts (#3319, `apps/background.ts`).
Every check step (install, test, check) and every crew run starts in the
background class: `SCHED_BATCH`, nice 10 (a CFS weight of 110 against the
forge's 1024) and best-effort IO at level 7, inherited by everything it
starts. Where the cpu and io controllers are delegated with memory, the
forge's leaf `<R>/forge` gets `cpu.weight` and `io.weight` 1000 against the
cells' 100, and a step's cell 10 against an app's 100. Each crew run gets a
cell cgroup of its own at weight 10 (no memory cap; it ran in the forge's
leaf, where only nice told it apart). The kernel holds each step's cell to
its declared cores (`check.limits.cpus`, by `cpu.max`) and each crew run to
`FORGE_CREW_CPUS` cores (default 4, at most 1024), so one busy check slows
itself instead of taking the pod's quota. Each is asked for and
none is required: a host without `chrt` or `ionice`, or one that refuses
them, runs the work as before. A full lane slows checks, not pages; an app's
own process is not lowered.

Where the host cannot hold cells (or the crew's shell sandbox), the forge
runs uncontained and says so in one line: a boot warning, and, in the foot of
every page a site admin reads, `Reduced protection: apps (<reason>) runs
uncontained.` (`kernel/protection.ts`), and the same line under the filter on
the terminal's first screen. Nobody else sees it, and a fully protected forge
shows nothing.

A private destination (a tailnet or LAN address) is reached only when
`egress` names it exactly, `"100.89.95.68:8101"` (an address or host with its
port; a range, a wildcard or no port is refused when `forge.json` is read) and
a site admin has granted that same `host:port` (`core/egress_grants.ts`). A
grant on :8101 does not open :22, and 169.254.0.0/16, loopback and the forge's
own pod and service ranges (`FORGE_NEVER_GRANT_CIDRS` adds more) are never
grantable. Until granted, the refusal says to add it and ask a site admin.
A grant needs the exact `host:port` in `egress`: a wildcard entry such as
`*.example.com:80` never opens a granted name. Grants are stored in the
`egress_grant` table and read at every app start. A site admin grants
and revokes on the app's settings page ("Private destinations asked for",
which lists the exact `host:port` entries forge.json names and who granted
each) or with `POST`/`DELETE /api/v1/repos/:owner/:name/egress-grants`
and a `{ "destination": "100.89.95.68:8101" }` body; `GET` lists them. Anyone
else who administers the repository sees the list with no buttons. A
destination forge.json does not name is refused, and each change is an
`app.egress.granted` or `app.egress.revoked` event with who and when. In the terminal a site admin
opens the repository's About (`I`), then `e`: `g` grants and `x` revokes the
destination under the cursor. The terminal is stricter than the page on
purpose: a repository admin who is no site admin sees the list read-only on the
page, and nothing on the terminal screen (no rows, no `g`/`x`).

A release that turns egress on must not break an app whose writers have
not declared what it uses yet, so the operator can start it reported:
`FORGE_CELLS_EGRESS=report` lets an undeclared public host through (on 80
and 443 only) and
counts it per repository (`<data>/egress/<repo id>.json`, under the
forge's data where no cell sees it), and the app's page tells its writers
which hosts it reached and the `egress` line to add. The default,
`enforce`, refuses them. Files, processes and private addresses are held
the same in both modes.

The forge starts the app with:

| variable           | value                                                                    |
| ------------------ | ------------------------------------------------------------------------ |
| `PORT`             | the port to listen on, chosen by the forge                               |
| `HOST`             | `127.0.0.1` — only the forge's proxy reaches it                          |
| `FORGE_APP_ENV`    | `production` or `preview`                                                |
| `FORGE_APP_DATA`   | this environment's data directory, created for it                        |
| `FORGE_APP_URL`    | the public URL this environment is served at                             |
| `FORGE_APP_COMMIT` | the commit being run                                                     |
| `FORGE_APP_PULL`   | the pull number, on a preview                                            |
| `FORGE_APP_SSH`    | the exact `ssh …` that opens this environment's terminal, when SSH is on |
| `FORGE_URL`        | the forge's own base URL                                                 |
| `FORGE_API_URL`    | the forge's JSON API, `FORGE_URL` + `/api/v1`                            |
| `FORGE_TOKEN`      | a read-only token of the repository owner's, this process's alone        |
| `FORGE_FEATURE`    | `1` while a site admin has absorbed the app as a forge feature ([docs/features/absorb.md](features/absorb.md)) |
| `FORGE_SETTING_*`  | each setting the app's `feature` declares, as the forge keeps it, while absorbed |

That last one is for the app to call the forge back on, not to run the forge
software itself — a shell that already has it set (a crew workspace does)
will make a locally-run forge refuse browser form posts as cross-site; see
`README.md`'s "Run it".

A terminal session (`tty`) gets the same variables plus `FORGE_APP_TTY=1`
and `FORGE_APP_USER`, the forge account at the keyboard or empty for a guest
— but no `FORGE_TOKEN`: a guest at the keyboard is not the owner.

### Live UI into the forge

`FORGE_TOKEN` is how a page an agent builds inside an app reads the forge
it runs on: `POST $FORGE_URL/mcp` (`now`, `map`, `apps`, `usage` — every tool that
does not write), the JSON API, and `GET $FORGE_URL/events`, the live stream
of everything the owner may see, with `Authorization: Bearer $FORGE_TOKEN`.
It also sends `run.log` frames (`{ run, lines, truncated }`), a run's new log
lines: no id, never replayed, and dropped while the reader is behind.
`examples/forge-live` is the worked example, and the acceptance test
(`test/apps-token.test.ts`) deploys it.

The token (`src/apps/token.ts`) is minted when a process starts — a deploy,
a crash restart, a wake — and revoked when that process stops for any
reason: replaced by the next deploy, asleep, stopped, torn down. It is
named `app:<slug>/<env>` among the owner's tokens and expires a day out;
the runtime's sweep pushes that forward while the process runs, so a forge
that dies without revoking it leaves a token that stops working by itself.

It is read-only on purpose. An app's pages are served to whoever its
`access` lets in, and a token that could act would let every one of them
act as the owner. Keep the token on the app's server — relay what a page
needs, never the token or the raw events — and keep a page that shows the
owner's forge behind `access: private` unless that is meant to be public.
Steering the crew (`say`, `tell`) stays the person's own act, on the forge.

An app that keeps its state under `FORGE_APP_DATA` gets production and
preview data for free. The scaffold does exactly that with `bun:sqlite`.

### Checks

A repository says how a change is checked, in the same file, beside or
instead of `app`:

```json
{
  "check": {
    "run": "bun x tsc --noEmit && bun test",
    "install": "bun install",
    "timeout": 1200
  }
}
```

The forge runs it against every commit a pull proposes — when the pull
opens, and each time its branch moves, a fork's included — and against
every push to the default branch, in a fresh export of that commit. The
verdict is a run of kind `check`, kept with its log beside the pull, in
the same place a preview's deploy reports and read by the same code: the
inbox badge, the pull's status, the crew. A failing check on an agent's
pull goes back to the agent with the log's tail, as a failed preview does,
bounded the same way. An app's own `test` still runs inside its deploy,
concurrently with `start` rather than before it; `check` is for a
repository that is not an app, or an app whose check is more than its
test. `install` defaults to `bun install` when the package
declares dependencies; `timeout` is seconds, twenty minutes by default.
A `check` that is present and wrong fails with the reason, so a commit is
never silently unchecked. A check under way when the forge restarts is
queued again, and the forge that carries on runs it from the start.

**An install failure is not a test failure** (`src/checks/install.ts`,
#5093). An install that fails with `Fail extracting tarball`, `EINTEGRITY`
or `ECONNRESET` is tried once more after 2 s. If it fails that way again,
the check is `failed: infrastructure`. It is queued again, and the merge
queue counts it as cut off, not red. If the re-run fails the same way, it
fails and says `infrastructure`. An uncontained check uses its
repository's cache (`<data>/check-install/<repo>/bun`), and installs into
it take turns under a lock file, so two never extract one package into the
same directory. A `job` check installs in its own pod with its own cache
and is not retried.

**A contained check installs from the shared cache**
(`src/checks/install.ts`, #7543). A check in a cell reads its repository's
cache and never writes it: before the install, the forge fills it on the
host from a scratch copy of the commit's checkout (no `bunfig.toml` or
`.npmrc` of the pull's, `--frozen-lockfile --ignore-scripts`, under the
same lock), and binds it read-only into the cell, which installs from it
copying. A warm install downloads nothing. The forge fills only a lockfile
whose every package is a plain `name@version` from the pinned registry
with a sha512 integrity (`src/checks/fillable.ts`); anything else
(workspaces, git, file or tarball URLs, patches, an override or
resolution to any of those, a binary `bun.lockb`)
installs into the cell's own cache as before, and the log says why.

That cache is bounded (`src/checks/install_evict.ts`, #7574): a fill, or an
uncontained install, marks the packages its `bun.lock` names as lent, and
under the same lock, in the background and at most hourly, the forge
removes entries not lent for 30 days (`FORGE_CHECK_CACHE_DAYS`), then the
oldest until the repository's cache is under 2 GB (`FORGE_CHECK_CACHE_MB`).
An evicted package is fetched again by the next install. Only the text
`bun.lock` is read: a repository on a binary `bun.lockb` lends nothing, so
its packages age out after 30 days and are fetched again.

**An app environment installs from that same cache** (`src/apps/process.ts`,
#7544). Before a cold checkout's `install`, production or a preview, the
forge fills the repository's cache on the host from the checkout's
`bun.lock`, the way checks fill it. The install then reads the cache:
read-only and copying inside a cell (`BUN_INSTALL_CACHE_DIR`), or under the
lock file without one. The environment's home stays its own, and a new
preview fetches nothing the cache already holds. A checkout with no
`bun.lock`, or one the fill does not trust, installs into its home as
before; so does one whose fill fails (the registry unreachable, the lock
cancelled, a timeout): the cache is an optimisation, and its failure is a
`cache not filled:` line in the deploy's log, never a failed deploy. A warm
start still runs no install.

Uncontained, the install holds the cache's lock for its whole run, since
an install outside a cell (its own lifecycle scripts included) could write
the cache. The cost: two cold environments of one repository install one
after the other there. Inside a cell the cache is read-only, so only the
fill takes the lock and installs run side by side.

**Placement.** `FORGE_CHECKS_PLACEMENT=process` (the default) runs a check
in a cell on the forge's machine. `job` runs install and check as one
Kubernetes Job (`src/cluster/jobs.ts`) instead: `FORGE_CHECKS_IMAGE` is its
image, `FORGE_CHECKS_CLAIM` a ReadWriteMany claim holding the forge's checks
root (mounted at the same path, where the checkout is exported),
`FORGE_CHECKS_NODE_SELECTOR` (`key=value,…`) and `FORGE_CHECKS_TOLERATIONS`
(a JSON list) say where it may land. Only `CI` and `FORGE_*` variables cross
to the Job. Its log is written into the run's log when it ends, and the run
records `placement` and the `node` its pod ran on. A malformed setting leaves
`process` in place. No cell wraps a Job. The pod mounts only its own
checkout (`subPath` = the run id), mounts no service-account token, runs
non-root without privilege escalation, and carries the check's limits as
`resources.limits`. **Egress is not enforced by the forge on a Job**: the
run is recorded as uncontained ("egress not enforced on a cluster job"), and
the pod carries the label `forge-check=true` so an operator's NetworkPolicy
can select it and hold what `egress` declares.

Checks share `FORGE_CHECKS_CONCURRENCY` slots (default `1`), and when one
frees, it goes to the most recently requested check waiting, not the one
queued longest — a fresh push is never stuck behind pulls that queued hours
earlier. The one exception is starvation: a check that has waited five
minutes to start outranks a newer one regardless, so nothing waits forever
and nothing waits out the lane's ten-minute budget only because it was passed
over.
A pull's status names how long its queued check has been waiting. The check
of the default branch that a landed pull asks for waits thirty seconds
before it may start: the merge queue lands a candidate's pulls seconds
apart, and each one's check is superseded by the next while still queued,
so the lane checks the head the candidate ends at, not every step on the
way.

### Environment

What an app needs that the repository must not carry — an admin password,
a payment key — an admin of the repository sets under **Settings → App →
Environment** (or `PUT /api/v1/repos/:owner/:name/app/env/:name` with a
`{ "value" }` body). A name is `ADMIN_PASSWORD`-shaped: capital letters,
digits and underscores; the names the forge sets itself (`PORT`, `HOST`,
`PATH`, `FORGE_*` and their kin) are refused, and the forge's own values
win regardless. Values are write-only: set one, and it is never shown
again — the page, the API and the event outbox carry the name and when it
was set, nothing more. At rest each value is sealed with the data
directory's key (`kernel/secret.ts`), bound to the app and the name.

The same list is in the terminal: an admin's repository screen has
*Variables* in its `:` palette, which lists names and scopes, sets one with
`a` (a name, a value typed masked, a scope) and unsets one with `d` after a
confirm, refused in the page's words (`actions/app_env_words.ts`). MCP
`app_env` does the same for an agent.

A variable has a **scope**: everywhere (`all`, the default), `production`
only, or `preview` only — the select beside the value, or `"scope"` in the
`PUT` body and `?scope=` on the `DELETE`. The same name may be set once in
each scope, and where two apply the narrower one wins: a test key for
previews, the live one for production, and neither process ever holds the
other's. Every preview is one scope, whichever pull it serves.

### Forge secrets

A credential the forge itself needs (a DNS token to spawn forges, a bucket
key for tofu state) is not an app's variable and never enters one. A forge
admin seals it under **Settings → Secrets**, or on an organization's page or
a repository's settings, or with `PUT /api/v1/secrets/:scope/:name`
(`{ "value", "ref" }`; `ref` is an org name or `owner/name`; scope is `forge`,
`org` or `repo`). Values are write-only; the list carries names, `updatedAt`
and `lastReadAt`. The only read path is `resolveSecrets` in
`core/secret_store.ts`: the narrowest scope wins, and each open appends a
`secret.read` event (actor, run, name, scope — never the value). Rows are
sealed under AAD `secret:<scope>:<name>`. Like every sealed row, they sit
beside the key in the data directory and so in a snapshot.

**A crew run's secrets.** An agent's brief, or an issue body written by someone
with write access, declares what a run may hold in front-matter at the top:

    ---
    secrets: CLOUDFLARE_API_TOKEN@api.cloudflare.com, TF_BUCKET_KEY
    ---

Only declared names are resolved (`crew/grant.ts`); malformed names and names
that would shadow the run's environment (`FORGE_*`, `GIT_*`, `PATH`, …) are
refused in the run's log. Values go into the run's env beside `FORGE_TOKEN`,
and `@host` widens the shell sandbox's egress for that run only. From the
moment they are opened the values are redacted (plain, base64, URL-encoded)
from the run log, the agent's last message and every event payload; before
the forge commits for the agent it scrubs them from the tree, and a branch
whose commits hold one is not pushed (`crew/leak.ts`). The names held are
recorded in `run_secret` and shown on the run page; the grant is dropped when
the run ends, and a sweep closes a crash's. A model that pushes by itself
cannot be stopped from pushing a value it transformed beyond those encodings.

A process reads its environment once, at start, so setting or removing a
variable redeploys what reads it, at its current commit, and nothing else:
a variable for everywhere redeploys production and every open preview, one
scoped to previews leaves production running as it was. The install and
test steps do not see them.

### The forge as an app of itself

The forge's own repository declares an app, so a forge can host the forge:
production runs `main`, and every pull gets a preview forge of its own —
the place to try a change that might not earn its keep, with the data it
would run against, and with a crew of its own to try it on. The manifest
is nothing special:

```json
"app": { "run": "bun run src/main.ts", "install": "", "health": "/healthz", "ready": 90 }
```

The forge knows when it is hosted: `FORGE_APP_URL` set means a forge put
it here, and it takes its address and its data directory from the host's
`FORGE_APP_*` rather than from `FORGE_URL` and `FORGE_DATA`, which name
the host. Hosted, the defaults change to what fits inside another forge —
no SSH listener (the host owns the port), one agent at a time, and its
apps' hostnames nested under its own: an app `cs` of the forge at
`lab--14--<domain>` answers at `cs--lab--14--<domain>`, and its previews at
`cs--3--lab--14--<domain>`. The host routes those by the tail of the label
— the part that names an app of _its_ own — and passes what stands in
front through in `Host`, untouched, for the guest to route. Anything set
explicitly still wins, so `FORGE_APPS=0` makes a hosted forge that serves
pages and git and nothing else.

A preview made with **copy** starts as a copy of the hosted forge — the
same accounts, repositories and crew, disposable — and, like any preview,
inherits the app's environment variables. That is how its crew signs in:
a `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`) set on the app under
**Settings → App → Environment** reaches every forge it hosts, and no
other secret of the host does — an app's environment is only what the
section above lists, and its admin comes from the operator's
`--first-admin`, as on any fresh forge: no sign-up makes one. `install`
is empty because the forge has no dependencies to fetch; `ready` is
generous because the first boot migrates.

## What a new app starts as

**New app** writes a small, complete app into the repository
(`src/apps/scaffold.ts`): notes behind a page, a JSON API, an MCP server
and a terminal, all over one set of actions, with no dependencies. What
the forge already does for every app (identity, the grant, preview data,
health polling, the terminal, the swap, sleep, the contract's wall) is not
repeated in it. What it adds is what an app owes its people on its own,
each proved by a suite of the app's own that runs on every deploy:

| guarantee          | where                                     | what holds it                                                                                                                                                                                                                                                                         |
| ------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the door           | `src/security.ts`                         | rationing, same-origin on writes, and the contract asked before the body is read: whoever the table lets through a resource's `api` door for no row at all is refused there (401 a stranger, 403 anyone else); `/openapi.json` is shut to strangers when the table opens them nothing |
| the audit trail    | `src/audit.ts`, table `audit`             | every create, update and delete, and every refused one, as a row (who, resource, verb, row, when, let or not); `GET /api/audit` for admins, as the `audit` resource's cells say; a row that cannot be written is a log line, never a failed request                                   |
| the API, described | `src/openapi.ts`, `contract/openapi.json` | each API route declares its shape beside itself; `bun run contract:emit` writes the file, each operation names its contract cell (`x-contract`), the suite fails while the committed file is stale, and `GET /openapi.json` serves it                                                 |
| up or not          | `GET /healthz`                            | `{ ok, version, commit, env, uptime }`, and `forge.json`'s `health` points at it                                                                                                                                                                                                      |
| the look           | `design/tokens.json`, `src/tokens.ts`     | W3C design tokens, light and dark, compiled at boot to `/tokens.css`; `bun run lint:design` refuses a raw `#hex`/`rgb(`/`hsl(` outside the tokens and a `var(--…)` no token defines; every pair a person reads is held to 4.5:1 in both themes                                        |
| the open web       | `src/page.ts`, `src/routes.ts`            | description, Open Graph and a card on every page; `/robots.txt` (the API closed to crawlers, a preview closed entirely, and `X-Robots-Tag: noindex` off production); `/.well-known/security.txt` redirects to the forge's own                                                         |

The scaffold's `AGENTS.md` tells the crew to keep all of it: every change
returns through `audited`, every API route carries its description, no
colour is spelled out, and the door is never routed around.
`test/scaffold.test.ts` writes the scaffold out and runs its suite and its
two scripts, so a change to the scaffold that breaks one of these does
not land.
The app's own `bun test` has a budget of 3 s, because every deploy and every pull on the app waits for it; `test/scaffold.test.ts` times it and fails above that.
The table the door reads knows two signed identities, `user` and
`admin`; a role such as a team's (`manage`) waits on the forge signing
one (see [CONTRACT.md](CONTRACT.md)).

## Who is there: identity from the forge

**Sign-in is OpenID Connect.** The scaffold's "Sign in" (`/signin`) is the
code flow with PKCE against `FORGE_URL` (see the last section). On first boot
it registers its own redirect address, `<FORGE_APP_URL>/signin/callback`, and
keeps the client id in `FORGE_APP_DATA/oidc-client.json`, so production and
each preview are separate clients. It verifies the `id_token` itself and keeps
a session in an HttpOnly cookie; a person signed in this way is a `user`. The
headers below remain only until a follow-up change retires them: once no app
reads `x-forge-identity` and `x-forge-signature`, the forge stops sending them
and `FORGE_APP_IDENTITY_KEY` goes with them (that change also settles where
`admin` comes from, which an `id_token` does not carry, and the scaffold's
sign-out, which still ends at the header-era `/__forge/signout`). Until then a
valid signed header outranks a session, so an admin who signs in this way stays
an admin.

An app never writes sign-in. The forge tells it who is there, on every
request it proxies, in two headers:

- `x-forge-identity` — `<user id>|<username>|<role>|<expiry ms>`, where the
  role is `user` (a signed-in person who can see the app's repository) or
  `admin` (one who can write it);
- `x-forge-signature` — the HMAC-SHA256 of that exact string, base64url,
  under the app's identity key, which the forge hands the app as
  `FORGE_APP_IDENTITY_KEY` when it starts it (the same key for production
  and every preview of the app, a different key for every app, derived from
  the forge's own so nothing new is stored).

No headers means nobody the forge could name: a visitor to a public app who
never signed in. The forge drops any copy of these headers a client sends
before it speaks, so a verified signature is the only thing an app has to
trust — and it must verify: a constant-time compare of the signature and a
check that the expiry is in the future (`src/who.ts` in the template does
exactly this).

Behind the headers is the grant. A person who opens an app through the
forge — the app's link, or the app's own **Sign in** — is sent to
`/apps/open`, which vouches for them if they may enter the app (anyone,
for a public app; a writer, the crew or a person it names, for a private
one) and sends them
back with a signed grant in a cookie naming them (twelve hours,
HttpOnly, SameSite=Lax). The forge answers two paths on every app's host:
`/__forge/signin?to=<path>` starts that round trip, and
`/__forge/signout?to=<path>` drops the grant. A private app admits nobody
without a grant; a public app admits everyone, and names those who have one.
An app of a forge hosted here (a nested hostname) routes both paths through
to that forge, which speaks for its own apps.

A third path, `/__forge/report?from=<path>`, is for a public app of a public
repository: it sends anyone, with no account, to the repository's report
form (STANDARDS.md, "Reports from outside") with the page they came from,
and is answered without waking the app, since the app being down is the
usual reason to ask. Such an app's HTML responses, and the forge's own "not
running" page for it, carry `Link: </__forge/report>; rel="help"` and a second `Link` with
`rel="alternate"; type="application/json"` to the forge's
`/api/v1/here?path=/<owner>/<repo>` manifest, and the
template's footer links to it. A private app or repository offers none of
this.

What each of them may do is a table, not code: the app's `contract.json`,
decided by the forge's own evaluator carried into the app. See
[CONTRACT.md](CONTRACT.md).

## A terminal for every app

The forge's own port answers `ssh`, and the login name picks what opens:
any name opens the forge's terminal UI, and an app's slug opens **that
app's terminal** — `ssh -p 2222 notes@forge` runs the app's `tty` command
on a real pty, in the deployed checkout, with the environment's own
variables (`FORGE_APP_DATA` and the rest, plus `FORGE_APP_TTY=1` and
`FORGE_APP_USER`, the forge account at the keyboard or empty for a guest).
`notes--12@forge` is the preview of pull 12's. The key still decides who
you are: a private app's terminal answers only to a key the forge knows
that can write the repository, or the crew's; a public app's answers to
anyone, as its web page does. Resizes pass through; closing the connection sends the program
`SIGHUP`.

The scaffold ships a small one (`src/tty.ts`, plain ANSI, no dependencies)
over the same SQLite file the web page uses, so a new app is reachable two
ways from its first minute. An app without a `tty` says so, in words, when
someone tries.

## Hostnames and the proxy

Apps are served from the forge's port by `Host`. With `FORGE_APP_DOMAIN`
(default: the forge's own host), production is `<slug>.<domain>` and the
preview of pull 12 is `<slug>--12.<domain>`. `--` cannot occur inside a slug,
so the two never collide. A build preview, one commit a writer asked to see
now (`POST /api/v1/repos/:owner/:name/builds/preview` with `{ "sha": … }`), is
`<slug>--b<sha7>.<domain>` (`build-<sha7>`): held in memory, at most three per
app, the oldest giving way, gone with the process; a slug may not be `b` and
seven hex digits. Where only single-label hosts are routable (a
wildcard certificate covers one label), give the attachment itself:
`FORGE_APP_DOMAIN=--forge.example` serves `notes--forge.example` and
`notes--12--forge.example`; a value that starts with a separator is used
whole, a bare domain gets the dot. Browsers resolve every `*.localhost` name to
loopback, which is what makes a laptop forge work with no configuration at
all: `http://hello.localhost:3000`.

A forge needs a hostname to hand out for this — not every address it can be
reached at is one. Attach a slug to a bare IP address (`127.0.0.1`, the
default when nothing sets `FORGE_URL` or `FORGE_HOST`) and the result,
`notes.127.0.0.1`, is not a URL: WHATWG rejects a hostname whose last label
is all digits unless the whole thing parses as an IPv4 address. The forge
checks this once at boot, for the host it is about to hand out. A loopback
address falls back to `localhost` on its own — same as the paragraph above,
and it says so in the log. Reached any other way by IP, there is no host to
fall back to that would resolve anywhere but here, so apps are left off
rather than started to crash: set `FORGE_APP_DOMAIN` to a real hostname
(anything DNS resolves to this machine) to serve apps on a forge like that.

The proxy is a `fetch` to the deployment's loopback port, streamed back.
Headers are forwarded with the usual `X-Forwarded-*` additions. An
environment that is not running gets a page from the forge that says so and
links the run — never a bare gateway error.

A websocket handshake (`Upgrade: websocket` with a key) goes through the
same gate — the private app's grant cookie, then a live port — and then the
forge opens its own socket to the app first, carrying the path, the query,
the cookie, `X-Forwarded-*` and the offered subprotocols. Only once the app
has accepted does the browser's side upgrade, with the subprotocol the app
chose; frames then pass both ways as they were sent, text as text and
binary as binary, and a close on either side reaches the other with its
code. A handshake the app does not accept, or an app that is not there,
gets the same "not running" page as a request would (502), never a socket
that opens and shuts. The limits: a frame is at most 16 MiB in either
direction; at most 16 MiB may wait for a browser that has stopped reading
before the socket is closed rather than the memory kept (the forge buffers
nothing of its own); and a socket that has sent nothing and answered no
ping for 120 seconds is dropped. The app's own 101 response headers are
not carried — a cookie an app sets on the handshake does not reach the
browser.

## Your own domain

An app can answer at a name you own — `app.example.com`, or an apex like
`example.com` — beside the hostname the forge gave it. Under **Settings →
App → Domains** an admin of the repository adds the name (or `POST
/api/v1/repos/:owner/:name/app/domains` with a `{ "host" }` body, MCP
`app_domains`, or `n` then `+` on the terminal's **Deploys** screen) and is
shown the two records to publish in the zone:

- a TXT record at `_forge-verify.<host>` whose value is `forge-verify=<token>`
  — the proof that whoever added the name holds it. The token is made for
  that one domain and is not a secret: it is published;
- a CNAME from `<host>` to the app's own hostname (`notes.forge.example`),
  which carries the traffic. An apex cannot carry a CNAME: use the DNS
  provider's ALIAS or ANAME record instead, or A and AAAA records with the
  address the forge is served at.

The forge checks when asked — **Check now** on the page, `c` on a domain in
the terminal's domains screen, or `POST …/app/domains/:host/check` — never on
a timer. It looks the TXT record up;
the domain is verified when some record there is exactly the value shown.
Every check leaves one sentence a person can act on ("No TXT record at
`_forge-verify.app.example.com` yet.", "The TXT record is there but holds a
different value.", "Verified; app.example.com points at
notes.forge.example."), and when it was said. Verification is a proof of
control at one moment, like a certificate's: the first check that finds the
record verifies the domain, and a record tidied away later does not take a
live site down. Removing the domain is what stops the forge answering there.

Once verified, the forge serves the app at that host — production, at the
same port, through the same proxy, with the same grant — and production's
URL becomes `https://app.example.com`: every "Open the app" link, the app's
JSON `url`, and the `FORGE_APP_URL` its process starts with. The app itself
learns its new address at its next deploy, because a process reads its
environment once. Until a domain is verified the forge answers for itself
at that name, exactly as it does for any hostname it does not know; a name
that is nobody's proof serves nobody's app. The hostname the forge gave the
app keeps working beside the domain.

A private app's sign-in works on the new host as it does on the old: a
visitor arriving at `app.example.com` is sent to the forge, vouched for, and
sent back to `app.example.com/__forge/grant`, where the grant cookie is set
for that host. One host names one app's production; a second domain on the
same app is served too, and the oldest verified one is the URL.

Whatever fronts the forge must route the name to it. A wildcard certificate
covers `*.forge.example` and not `app.example.com`, so the proxy needs a
certificate per domain. With Caddy, `on_demand_tls` fetches one the first
time a name is asked for, and asks the forge first whether the name is
anyone's: `GET /__forge/domains/ask?domain=<host>` answers 200 for a
verified domain and 404 for anything else, so a stranger cannot make the
proxy fetch certificates for names that are not here (`docs/EXTRACT.md`
has the Caddyfile). A tunnel routes the host the way it routes the
wildcard. The forge itself speaks plain HTTP either way.

## A release does not drop a session

The forge is one process on one volume, and a release replaces it. The new
process comes up beside the old one and takes everything new once it is
ready; the old one drains: it starts no new crew runs and lets the ones in
flight finish and land (a run cut short is a person's money spent twice),
stops its apps and its checks, says so on `/readyz`, and keeps serving
whoever is connected over SSH until they leave — for up to an hour — and
only then goes. A run that does have to be cut short, by a crash or the
hour running out, is queued again to carry on in the clone it left, in the
same session. SQLite in WAL mode carries two processes for that window.
Each running run carries a lease its process renews every fifteen seconds;
a forge coming up fails only runs whose lease has lapsed, so the old
process's live work is never mistaken for a crash's leftovers, and a real
crash is still cleaned up within a minute or two.

An app goes through a release without a refused connection (#4496). A
forge with apps on beats `serving/<id>.json` on the data volume every 5 s
(`apps/presence.ts`). A new forge that finds another still beating — fresh
within 15 s, and on the same host a pid that runs — starts every app's
production and answers `/readyz` 503 (`starting N apps`) until each serves
or fails, for up to two minutes (`STARTING_BUDGET_MS`, `http/health.ts`);
the platform keeps routing to the old forge, whose copies still serve,
until then. A cold start — a crash, an eviction, the first boot — finds
nobody serving in its place and is ready at once, as is a forge whose
predecessor stops beating during the wait. The old forge stops
its apps only after its linger, once routers have moved: each proxied
websocket is closed with 1012 Service Restart (`apps/handoff.ts`) — a
client reconnects at once, to the new forge — and each request still with
the app is given up to 30 s to be answered before the app is stopped. An
app's own deploy hands over the same way: the new version serves first,
then the old one's sockets get 1012 and its requests their 30 s. The
**App restarts** board counts every production start over one that
served, per day and per app, with its cause: its own deploy, a forge
roll, a crash, or the memory cap (`oom`).

The app's process still restarts on a forge release: it lives in the
forge's pod, and the old pod's processes go with it. A forge roll is
counted on that board so the rate is visible; keeping the process itself
running across a roll needs the cells supervised outside the forge
process, which this does not do.

## Where state lives

Git is truth for code. The app's serving configuration (slug, access, the
preview-data policy) is forge state, like a webhook. Everything else is
either derived or ephemeral:

```
<data>/apps/<app id>/production/data          production data — lives forever
<data>/apps/<app id>/production/<commit7>/    a checkout, one per deployment
<data>/apps/<app id>/pull-<n>/data            preview data — dies with the pull
<data>/apps/<app id>/pull-<n>/<commit7>/      the preview's checkout
<data>/runs/<run id>.log                      every run's log, appended live
<data>/crew/<agent>/<repo id>/<issue n>/      an agent's clone, kept while its pull is open
```

Rows: `app` (repo, slug, access, preview_data), `app_env` (name, sealed
value), `run` (repo, kind, issue, commit, state, summary, cost, timings —
`startedAt`, `servingAt`, `finishedAt`), `agent` (user, model, brief,
budget), and `issue.assignee_id`. The current deployment of each environment is in
memory only: a process is not state, and a restart rebuilds every
environment from the default branch and the open pulls, exactly as
`core/reconcile.ts` rebuilds the index from git.

## Runs

A run row is created `queued`, claimed with a compare-and-swap into
`running` (two workers cannot both take it), and finishes `ok`, `failed` or
`cancelled` with a one-line summary. Its log is a file the surfaces tail live
through an in-process listener; the file is the truth, the listener is the
optimization. `run.queued`, `run.started` and `run.finished` ride the event
outbox like every other state change, so webhooks and the SSE stream see
them.

A run's page is a transcript, drawn line by line as it is written: who
speaks in a column — the agent, the forge, _you_ — the tools the agent
reached for as quiet chips, the clock running and, at the end, what the run
cost in money and turns. The transcript keeps to its end until the reader
scrolls up, then offers the way back down. The stream numbers every line,
so a browser that reconnects hears only what followed; nothing on the page
reloads under a reader.

**Steering.** Under the transcript, a composer. A running agent hears what
is typed there as its next turn: the forge drives Claude Code over its
stream-json input and keeps the session open while a word is pending, so
_also add a test_ arrives after the step the agent is on, in the same
session, with everything it already knows. Enter sends. The words are kept
in the log as `you:` lines, and the same composer on a run that is over
puts them on the conversation instead, where the next run reads them. A
comment or review left on the issue or pull while the agent works reaches
it the same way, as its next turn, rather than queuing a second run behind
the first; only when nobody is listening does a follow-up run queue, and
one waiting is enough. _Stop_ sits beside _Send_ while the run goes.

Each agent's row on
the crew page carries the numbers that say how it is doing: runs and how
many landed, pulls a person merged, spend, and the mean cost, time and
turns of a run.

On a pull, the runs for the current head are its checks. A deploy run that
fails — install, build, or the app never answering — fails the check before
anything serves; the preview shows the log where it stopped. A deploy whose
app answers but whose `test` then fails is different: the preview keeps
serving that commit, but the run still fails the check, and the page says
in words that it is serving code whose tests failed. A push makes new runs;
older ones are history, not status.

### The look

When a deploy comes up green the forge takes a picture of it — every page
`app.looks` names, `/` alone when it names none — at a phone's width
(390×844), a laptop's (1280×800), and a thumb's (200×125, desktop's own
aspect, small), and keeps the pictures beside the commit they are of, so a
person judges a change from what it is rather than from what it says.
`app.looks` may name at most 24 pages: a browser start per picture per
width is the heaviest thing the forge does, and more is a manifest error
rather than a silent, slower deploy. The pull page shows the phone and
desktop pair under the checks, with the commit and a word when the head has
moved since; more than one page gets one group per page, each labelled by
its path, since a page that failed keeps its last good picture while another
moves on. The studio's ask row, the board's landed row, and an app's studio
head always show the home page's own picture, whatever else `app.looks`
names — the thumb, or (before it existed on that commit) the phone shot that
slot used to load, so nothing goes blank. Pictures are served at
`/:owner/:name/looks/<env>/<commit>/<kind>.png` for the home page, or
`/:owner/:name/looks/<env>/<commit>/<page>-<kind>.png` for another, with the
repository's own read access, cached by commit.

Each page is also pictured in the dark (#2736): phone and desktop again, with
the browser's `prefers-color-scheme` forced to dark, kept in a slot of its own
(`phone-dark.png`, `board-desktop-dark.png`) with `theme` = `dark` on its row.
A look recorded before this has no theme and reads as light; the thumb stays
light, and every listing of looks means the light ones.
On the pull page the dark pair sits in a collapsed "In the dark" fold under the
light one (no script needed, and four tall pictures never stack open on a
phone), and only the dark pictures of the commit the caption names are shown.
The terminal pull screen shows no looks, light or dark: looks are a web page
thing.

The phone and desktop pictures are what the repository's owner would see:
headless Chromium is pointed at the forge's own listener with the app's
hostname resolved to loopback, through the grant door, so the app renders for
a signed-in admin exactly as when the owner opens it — and they are its
writers' alone. The thumb is taken as nobody, for the tiles strangers see. A
public app on a public repository is the world's to see, so all three of its
pictures are taken as nobody, and a reader of its pulls sees the Look card
too; each row records who it was `taken_as` (#727, #738). A page named in
`app.looksAsOwner` (each must also be in `app.looks`) is the exception: its
phone and desktop are taken as the owner even of a public app, and stay the
writers' — an admin's own page shows a stranger nothing (#8812,
`docs/features/preview-owner-looks.md`). It is taken as the page loads — what an
app draws after that is not in it — and one at a time, forge-wide, bounded
in time and memory. A look is best-effort: it never blocks a check or fails
a run; one that could not be taken is recorded with its reason, and the
page says "no picture" honestly. One look per environment and head; a
newer head replaces one still waiting; one that waited ten minutes is
dropped. The pictures live as long as the environment: a preview's go when
its pull closes. Files live under `<data>/looks/<app id>/<env>/`; rows in
`look`. The browser is `chromium` (or `chromium-browser`, `google-chrome`)
on `PATH`, `FORGE_CHROMIUM`, or the Mac's own; the image ships one. A forge
without one says so once at boot, and on every pull.
**A look a person attaches.** A person who can write the app (an agent
cannot; the crew's looks come from the preview) attaches a picture to an
open pull: `POST /api/v1/repos/:owner/:name/pulls/:number/looks` with JSON
`{width: "phone"|"desktop", says: "one line", image: "<base64 PNG or JPEG>"}`,
at most 5 MB, or the MCP `attach_look`. It is read as bytes (a PNG or JPEG
that parses, nothing else), kept under the preview's folder at the pull's
head, and shown in the Look card beside the crew's, to the writers only.
It stays when the head moves on and goes with the preview when the pull
closes.


## The crew

An agent is created once (`New agent`: a name, a model, a brief) and given
access like anyone else. Work reaches it three ways, all off the event
outbox with a sweep behind the wake-up:

- **Assignment.** An issue assigned to an agent starts a run. The agent
  clones the repository, works on a branch named after the issue, and
  pushes. The clone is the triangle git was built for: it fetches from the
  repository and pushes to the agent's fork, so a plain `git push` lands
  where the agent may write and nowhere else. The forge opens the pull on
  its behalf, from the fork — the agent's closing message is the
  description — so the bookkeeping is never the agent's to get wrong.
  Assigning a pull re-engages the agent on that pull. A push to the fork
  moves the pull: the repository's snapshot of the branch and the preview
  built from it follow.
- **Feedback.** A review that requests changes, or a comment on the
  agent's pull that addresses it, starts a follow-up run that resumes the
  agent's session with the feedback quoted. A follow-up that begins after
  the pull was merged works on a fresh branch from the default branch and
  lands as a new pull that names the one it continues.
- **A failed check.** A deploy that fails on the agent's pull, or the
  repository's own check failing on it, starts a follow-up with the log's
  tail. Bounded by rule 7. A failure the crew reads as the place it ran —
  a timeout, a missing tool, a flaky runner — runs the check again once
  for that commit instead, and spends none of the pull's tries; a second
  red on the same commit is taken at face value, and what the pull is
  parked with says which of the two failed.

Forks follow their parents. A fork's default branch is a copy of the
parent's until someone commits on it, and while that is so the parent
moving is the fork moving — fast-forward only, as pushes land, a mirror's
sync included. A fork with commits of its own on that branch is left as it
is by that following; `Update from parent` on its page (or `POST …/sync`)
merges the parent in, as a merge commit authored by the person who asked,
and refuses with 409 `{error: "conflict", files, message}` when both sides
changed the same files (`docs/FOLLOWING.md`). This is
what lets one person's fork stand between the crew and the outside world:
the crew proposes into it, the person merges there, and proposes the
result onward as one pull (see `docs/ORIGINS.md`, "a fork of a mirror").

An agent may decline. A last message that starts with `DECLINED:` ends the
run as failed with that reason, posted on the issue or pull, and nothing it
touched is pushed — a mis-scoped task parks with an explanation instead of
becoming an empty or wrong pull.

A run's budget is not spent to the last cent on the task. The end of it —
fifteen percent, at least fifty cents, never more than half — is held
back, and an agent that spends the rest gets one short turn in the same
session to land what exists: run the tests, drop what is half-done, commit,
push, and write the description anyway. The pull says where the work
stopped and at what spend.

A run the provider turns away — a rate limit, a usage window that has
closed, an overloaded model — has nothing wrong with it, so it is not
failed. It pauses: the run ends cancelled with a `paused:` summary, its
clone is kept exactly as the agent left it, and its task is queued again
for a minute after the reset the provider named (fifteen minutes on, when
it named none). The run that starts then resumes the same session in that
clone and is told to carry on. A task is paused at most six times before
the forge stops waiting on it.

Each subscription keeps a _standing_ (`core/standing.ts`): where it is in
its 5-hour and weekly windows — started, resets, cap, used, remaining, in
US dollars of list price. When the provider turns a run away, the window
it named and its reset are kept as _read_; everything else is _inferred_
from the usage ledger — a window opens at the first run after the last one
closed, and the cap is what the crew had spent when the provider last
called the window full (a person's own use is not in the ledger, so it is
a floor). An operator keeps a share of every window for people
(Settings → Subscriptions, 0–90%); `crewRemaining` is what is left after
it. Both read on `GET /api/v1/repos/:owner/:name/usage` and the MCP
`usage` tool, under `standing`. Without a repository, `GET /api/v1/usage` and
the same tool answer for every app you can write: `today` (since 00:00 UTC)
and `last24h` (rolling) named apart, per subscription, with each window's
`headroom` as the percent of its limit still free (`null` until the provider
has named a limit). Not in the terminal yet.

Across repositories, the _fleet graph_ (`GET /fleet/graph`) draws a
selection's spend and runs from the same ledger: the last 24 hours by UTC
hour and the last 14 days by UTC day, stacked per repository, with the
numbers as a table beside it. The selection is `?repo=owner/name`,
repeated; absent, it is every repository you can write that spent in the
last 14 days. A run counts in the bucket it ended in. Past eight
repositories the smallest spenders share one grey series, "N others".
The page redraws every 30 seconds while it is open, and at once on a
`forge:fleet-op` event, so an operation's effect shows within a minute.
The same numbers are `GET /fleet/graph.csv` and `GET /api/v1/fleet/graph`;
spend is the owner's fact, so a repository you cannot write is dropped
and counted with the names that do not exist, never told apart.

Before a fleet operation acts, `GET /fleet?q=<query line>` shows the rows
its query line selects, as a table: `repo autonomy:autonomous`,
`run state:queued`, `issue assignee:none`. The grammar and the rule that
a repository you cannot read is absent are `src/fleet/selection.ts`'s; a
line that does not parse shows why beside it. Headers sort by one column
(`&sort=<column>`, `-<column>` descending), without JavaScript. Past 500
rows the page asks for a narrower query rather than cutting the list.

The agent runs Claude Code headless in its clone, with a prompt the forge
composes: who it is, what the task is, how to finish, and what will be
refused. Permissions are the forge's, passed as settings: file tools
confined to the clone, no prompts (anything that would ask is denied), a
spend budget, and Claude Code's own sandbox around the shell — seatbelt on
macOS, bubblewrap on Linux where it is installed — with a policy the forge
writes per run (`crew/sandbox.ts`): the network is the forge and the
package registry (plus `FORGE_CREW_ALLOW_HOSTS`); writes stay in the clone
and the temp dir; reads are refused for the forge's repositories, its
index and key, every other agent's clone, and the operator's own
credentials (`~/.ssh`, `~/.aws`, and their kin). The crew probes once at
start whether the host can hold a run to that — bubblewrap, socat and a
user namespace it is allowed to make — and where it cannot, as in a
locked-down container, the sandbox is handed over switched off and every
run's log says so in one line, rather than warning on each command and
running anyway. The repository's own
`AGENTS.md` is read the way Claude Code always reads it, so a repository
can steer its crew without touching the forge.

The forge asks the host for one more binary than before: `claude`, found on
`PATH` or at `FORGE_CLAUDE`. Authentication is the operator's — an
`ANTHROPIC_API_KEY` or a `CLAUDE_CODE_OAUTH_TOKEN` in the forge's environment
is handed to the run, or the machine's own Claude Code login is used when
there is neither. When neither
works the crew page says so, in words, before anyone assigns anything.

### Asleep

A preview whose pull has had no push and no comment for three days is
stopped and shown as _asleep_ with when and why — its row, data and pictures
stay. It is not failed, and a restart leaves it stopped. Asking for it (a
request to its host, or **Wake it** on the change's page) deploys it again
on the ordinary deploy path. Production, and a pull with a run queued or
running on it, are never put to sleep this way. `FORGE_PREVIEW_IDLE_DAYS`
sets the age; `0` keeps every preview warm.

An environment nobody asks for does not keep a process. A preview that has
served no request for thirty minutes, or production for a day, is stopped
and marked _asleep_, its checkout kept whole; the next request through the
proxy starts it again — warm, without install or test, in about the time a
page takes — and waits for it rather than showing a closed door. The forge
coming back does the same: production starts warm from the checkout it kept,
and every preview comes back asleep until someone looks. A restart used to
mean thirty installs and test suites at once; now it means starting what
people are using.

Quiet is not the same as idle. Before it sleeps an environment the sweep
asks whether it is _busy_ (`apps/busy.ts`): a child process of the app's
still alive — a build, a crew run inside a hosted forge — or a websocket or
event stream the proxy holds open to it. A busy environment is left awake,
the app page and the Now card say _busy_ and why, and its deploy log says
it was kept awake. Busy buys one crew run's length past the idle window
(`FORGE_CREW_TIMEOUT_MIN`, 45 minutes by default) and no more, so an app
that keeps a child forever still rests.

### The meter

Awake and asleep are also what an app costs, so the runtime writes them
down (`core/meter.ts`). Every stretch an environment serves is one row in
`meter` — repository, environment, placement (`owned` or `cloud`), started,
ended — opened when a deploy or a wake starts serving (a redeploy keeps the
same row open) and closed when it sleeps, stops, crashes, is torn down or
the forge shuts down. Each sweep is a heartbeat on the open rows; a row the
last forge left open is closed at boot at its last heartbeat, never left
running. Once an hour the runtime samples each app's bytes — every
environment's `FORGE_APP_DATA` and its bare repository, files only, links
not followed (`apps/bytes.ts`) — into `storage`. `usageBetween` reads both
for a `[from, to)` range: awake seconds per app (by placement too) and
GB-hours, bytes × hours / 1e9, each sample standing for the hour after it
or until the next one.

### Subscriptions

One token in the environment is one account for the whole forge. An admin
with more than one — a personal plan and a work plan — adds each under
Settings → Subscriptions (a token from `claude setup-token`, or an API key;
whitespace and a `Bearer ` prefix from the paste are dropped; sealed under the
forge's key, never shown again) and grants it:

- on a repository's Settings → Crew, to everyone on the crew or to one agent;
- on an organization's page, for every repository under it.

A run takes its token from the nearest grant, whole: the repository's before
the owner's, the agent's own before the crew's. A grant whose accounts are
all resting holds the run until the first wakes rather than falling through
to a wider one, so a work repository never quietly spends the personal plan.
Two accounts on one grant take turns, the one used longest ago first. When
the provider turns an account away — a session's window, the week's limit —
that account rests until the time the provider names (now read from
`resets Sep 26 at 9pm (America/Chicago)` as well as `resets 7am (UTC)`), the
next account on the grant takes the run at once, and the pool page shows who
is resting and why, with a button to use it again sooner. Nothing granted
anywhere means the forge's own token, as before. Every run remembers the
account it spent.

### Prompts from Instagram

A repository's next tell can come from its audience. Under Settings →
Prompts an admin connects the Instagram account of the app — a game with
an account of its own, say — and once a day the forge reads the account's
latest Reel, takes its most-liked top-level comment, and tells the crew
exactly as a person would from the studio box: an issue is opened and
routed to a builder. The comment is the tell; the forge invents nothing.

What happens at the hour, every day, in UTC:

1. The token is refreshed when it is more than fifty days old (below).
2. The account's username is read once, the first time, and shown.
3. The latest Reel is found — the newest item Instagram marks `REELS`, or
   the newest video where it marks nothing.
4. Its top-level comments are read, at most four pages of fifty. The top
   comment is the one with the most likes; a tie goes to the earliest. A
   comment with no text does not count.
5. The crew is told, and the Reel is remembered as told.

The tell has one shape. Its first line is the issue's title, as with any
tell, and the rest is its body:

```
<the comment, as written>

From Instagram: the top comment (<n> likes) by @<username> on the Reel of <YYYY-MM-DD>. <permalink>
```

Nothing is told twice, and nothing is told early. A Reel already told is
skipped ("No new Reel since <date>; the last one was told as #<n>."), a
Reel with no comments yet is left for tomorrow and _not_ remembered as told
("The latest Reel has no comments yet."), and an account with no Reel says
so ("No Reel yet."). Every run leaves its sentence on the settings page, and
**Fetch now** runs the same routine at once, whatever the hour. A run that
meets an error ends in a sentence too, never a throw: Instagram's own words
in one line, or — for a token Instagram no longer accepts — "connect the
account again". A repository whose routine ran today does not run again
until tomorrow, and one whose forge was down at the hour catches up on the
next tick.

The token is a long-lived Instagram user token, which lives sixty days. It
is sealed under the forge's key, bound to its row, opened only for the run,
and never listed or shown again; the API's listing carries the account, the
hour, and what the last run said, and nothing else. When it is more than
fifty days old the forge refreshes it — Instagram allows a refresh once a
token is a day old — stores the new one sealed, and notes the time, so a
token pasted once stays good for as long as the account does. A token the
forge cannot open (a data directory restored under another key) asks to be
connected again, like everything else about a lost key.

The one-time steps at Meta, none of which needs App Review for an account
of your own:

1. Make the Instagram account a professional one (Business or Creator).
2. At developers.facebook.com, make a Meta app and add the **Instagram**
   product with Business Login for Instagram. No Facebook Page is needed.
3. Get a token for the account with the scopes `instagram_business_basic`
   and `instagram_business_manage_comments`.
4. Exchange it for a long-lived token, the one that lives sixty days.
5. Paste it under Settings → Prompts, choose the hour, and press Add — or
   `POST /api/v1/repos/:owner/:name/prompts` with
   `{ "kind": "instagram", "token": "…", "at": "15:00" }`.

`prompt.told` on the outbox names the source, the Reel, the comment and the
issue; it is for the repository's admins, like everything else about its
settings.

## Something that needs you reaches your phone

Under Settings → Profile a person may set one **notify URL**: an `https:`
address that takes a POST of plain text (an [ntfy](https://ntfy.sh) topic
does). When the forge's events change what asks them — a pull the crew
stopped on, a green pull waiting for a look, a repository at its ceiling —
one line and a link to the asks screen is posted there (`src/crew/notify.ts`).
A milestone the person watches says one line too, once, when it lands, with
a link to the milestone (`docs/PLANNING.md`); its progress never does.

- *New only.* What asks a person is read as that person, the way the asks
  panel reads it, so a private repository's titles never go to someone who
  cannot read it. An ask is told once; it is new again only after it went
  away and came back. A restart, or saving the URL, starts from what asks now.
- *Bounded.* Ten an hour per person. A failing endpoint pauses that person's
  notifications for a minute, doubling to an hour; what could not be sent is
  dropped, never retried or queued. Nothing blocks the event stream.
- *The URL is a secret* (a topic name is a password). It is `https:` only,
  without credentials, at most 200 characters, and refuses loopback, private,
  link-local, `.local`, `.internal` and bare hosts. The name is resolved and
  judged again at send time and redirects are not followed. It is kept in the
  user's settings, never logged, and the account page shows only its host.
- *Doors.* Settings, MCP `notify`, `GET`/`PUT /api/v1/user/notify` and the
  terminal's "Phone notifications"
  screen (`src/tui/screens/notify.ts`: `s` sets, `x` turns off after a confirm)
  all go through `setNotifyUrl`. The API door is a person's only (an agent
  gets 403) and `PUT` needs an admin-scope token; both answer only the host.
  The terminal draws the typed URL as dots and
  shows only the host; an agent is not offered the screen.
- Not here yet: a health problem for an admin has no event to ride.

## Configuration

| variable                  | default                         | meaning                                           |
| ------------------------- | ------------------------------- | ------------------------------------------------- |
| `FORGE_APPS`              | `1`                             | `0` runs no apps and no crew                      |
| `FORGE_APP_DOMAIN`        | the host in `FORGE_URL`/`_HOST` | what app hostnames attach to (`example` or `--x`) |
| `FORGE_APPS_CONCURRENCY`  | `2`                             | deploys running their heavy steps at once         |
| `FORGE_PREVIEW_IDLE_DAYS` | `3`                             | days a pull may sit untouched before its preview sleeps; `0` = never |
| `FORGE_CREW_CONCURRENCY`  | 1 per 3 GiB above 2 GiB, 2–16   | agent runs at once (live: Settings → Capacity)    |
| `FORGE_CHECKS_CONCURRENCY` | `1`                            | checks at once (live: Settings → Capacity)        |
| `FORGE_CHECKS_PLACEMENT`  | `process`                       | `job` runs a check's commands as a cluster Job (see Placement above) |
| `FORGE_CHECKS_DRAIN_S`       | `10`                           | seconds a roll lets running checks finish first   |
| `FORGE_CREW_DRAIN_S`         | `10`                           | seconds a roll lets crew runs finish before they are queued again |
| `FORGE_CHECK_SHARDS`      | the machine's cores             | test shards per check (live: Settings → Capacity) |
| `FORGE_CHECK_CACHE_DAYS`  | `30`                            | days a package may go unlent before the check install cache drops it |
| `FORGE_CHECK_CACHE_MB`    | `2048`                          | size one repository's check install cache is swept down to |
| `FORGE_CELLS_EGRESS`      | `enforce`                       | `report` lets undeclared egress through on 80/443 (live: Settings → Capacity) |
| `FORGE_CELL_CGROUP`       | `/sys/fs/cgroup` at a namespace root | the delegated cgroup v2 whose children cap each cell's memory; `off` watches only |
| `FORGE_CREW_CPUS`         | `4` | cores one crew run may use (`cpu.max` on its own cell cgroup, where the cpu controller is delegated) |
| `FORGE_CREW_BUDGET_USD`   | `5`                             | spend per run unless the agent says otherwise     |
| `FORGE_CREW_TIMEOUT_MIN`  | `45`                            | wall-clock limit of one agent run                 |
| `FORGE_CREW_ALLOW_HOSTS`  | —                               | hosts an agent's shell may reach, comma-separated |
| `FORGE_CLAUDE`            | `claude` on `PATH`              | the Claude Code binary                            |
| `FORGE_CLAUDE_CONFIG_DIR` | conversations: `$FORGE_APP_DATA/claude-config`; runs: Claude Code's own | a `CLAUDE_CONFIG_DIR`; conversation sessions live there so a release keeps them |
| `FORGE_CHROMIUM`          | `chromium` on `PATH`            | the browser the look is taken with                |
| `ANTHROPIC_API_KEY`       | —                               | handed to agent runs when set                     |
| `CLAUDE_CODE_OAUTH_TOKEN` | —                               | handed to agent runs when set                     |
| `TYPESAFE_API_KEY`        | —                               | TypeSafe's Jev answers fixed-choice decisions     |
| `TYPESAFE_MODEL`          | `jev-latest`                    | the TypeSafe model to ask                         |

The public URL apps and agents are told about the forge is `FORGE_URL` when
set, else `http://<FORGE_HOST>:<PORT>`; its scheme and port are what app
URLs are built with, so a forge behind TLS on a wildcard domain sets
`FORGE_URL=https://forge.example` and `FORGE_APP_DOMAIN=apps.example`.
Hosted by a forge (`FORGE_APP_URL` set), the address is `FORGE_APP_URL`,
the data directory `FORGE_APP_DATA`, and the defaults become
`FORGE_SSH_PORT=0`, `FORGE_CREW_CONCURRENCY=1` and
`FORGE_APP_DOMAIN=--<its own host>`.

Every limit an owner can hit (crew runs and checks at once, budget
ceilings, per-account caps, sign-in rates) is listed with its value and its
reason under **Settings → Limits** (`/admin/limits`, forge admin only),
declared in `settings/limits.ts` and read on every use.
The same list is MCP `limits` and the terminal's **Limits** command (Ctrl+K,
then Limits; a forge admin who is a person, never an agent): each row shows
the key, value, default and bounds. `e` asks for a value (empty restores the
default), shows the plan as from → to, and changes it only after a confirm; a
value out of bounds is refused in the same words as MCP.

Four of these are the forge's capacity and change while it runs: crew runs
at once, checks at once, shards per check, and the cells' egress mode. A
forge admin sets them under **Settings → Capacity**, through
`PUT /api/v1/admin/capacity/:key` (`{"value": "1"}`, `null` for the
default) or the `capacity` MCP tool; the next crew run, check or cell
honours the change, never a restart. The variable stays the boot default
until a value is set, and every change is listed on that page with who
made it, when, and from what to what (`core/capacity.ts`). The shard count
reaches a check's commands and an agent's shell as `FORGE_CHECK_SHARDS`,
from the setting, never from the forge's own environment.

### Boards: counting the forge's own tables

A site admin who is a person (never an agent, whatever its token's scope)
reads the forge's tables as counts through two routes; anyone else gets
403, a signed-out caller 401. `GET /api/v1/boards/sources` lists each
source with its `time` column and its columns' types (`boards/sources.ts`;
a column holding a secret or free text is never listed).
`POST /api/v1/boards/query` takes
`{source, from, to, filter, groupBy, aggregate, column}`:

- `source`: a name from the list; `aggregate`: `count`, `sum`, `avg` or `max`
  (the last three need a numeric `column`).
- `from` (inclusive) and `to` (exclusive): dates, applied to the source's time column.
- `filter`: up to 16 of `{column, op, value}`, `op` one of `eq ne lt lte gt gte`,
  or `starts` (a prefix of a text or time column, matched literally).
- `groupBy`: a column, or `{"bucket": "minute" | "hour" | "day"}`.
- `step`: with a bucket only, seconds per bucket in its place (1 to a
  year); each point is floored to its bucket in UTC.

It answers `{"rows": [{"group", "value"}]}`. A query grouped by a column
stops at 1000 rows; one grouped by time is never cut short: past 20000
rows it is refused (`400 bad_query`, "ask for a coarser step"). A query the
module refuses is `400 bad_query` with its message; a body that is not JSON
is `400 bad_json`; a body over the cap is `413 too_large`.

Each panel of a board is its own door, `GET
/api/v1/boards/:slug/panels/:id` (`:id` its place from 0;
`boards/panel_data.ts`), answering `{board, panel, title, chart, from, to,
step, rows}`. `from` and `to` (dates) stand in for the panel's, and the
board's range is the start when neither names one; `step` is seconds or a
count with a unit (`300`, `15s`, `5m`, `1h`, `1d`). Without a step a panel
grouped by time picks the finest of 1 min, 2, 5, 10, 15, 30 min, 1, 2, 3,
6, 12 h, a day or a week that keeps it within 360 buckets (a 24 h board is
5 min, 288 buckets; with no start, as on an `all` board, the span runs from
the panel's oldest row), and steps coarser while an answer is too large; a step
asked for is kept or refused, never cut. A panel grouped by a column
ignores `step` (`"step": null`). `format=csv` is the same rows as
`group,value` or `group,series,value`; a text cell that starts with `=`,
`+`, `-` or `@` is prefixed with `'` so a spreadsheet does not run it. A bad
window or format is `422`, a missing board or panel `404`. The board page
and home's pinned panels draw through the same door, and each card links its
`json` and `csv` beside `explore`; the `boards` MCP tool with `slug` and
`panel` answers the same, and the terminal's board screen says each panel's
last bucket and step.

The `machine` source is what the machine itself used (`boards/sampler.ts`):
every 15 s the forge reads its pod's cgroup v2 (`cpu.stat` `usage_usec` as a
rate, `memory.current`), each labelled check and app cell's process tree
(`check:<run id>`, `app:<slug>/<env>`), and the node (`/proc/stat`,
`/proc/meminfo`, `/proc/loadavg`). Each logical CPU is a target of its own,
`cpu:<nnn>` (zero-padded, so they sort): its `/proc/stat` line as a rate, at
most 1 core, and in `celsius` the temperature of the core it runs on — the
`coretemp` chip's `Core <K>` input under `/sys/class/hwmon`, matched by the
CPU's `topology/physical_package_id` and `core_id`. Every other thermometer
(a `coretemp` package, `k10temp`, `acpitz`, a disk) is `package:<id>` or
`sensor:<chip>/<label>`, °C only. A board picks the cores with the filter
`target starts cpu:`; the machine card on `/boards/data?source=machine`
links a per-core CPU and a per-core temperature query. On an 80-CPU node
that is 80 more targets, about 1.2 M rows at most (~80 MB) in the ring.
The `forge` target also carries whether the forge still serves (#3319):
`lag_ms`, its event loop's p99 lateness over the step in ms (a timer asks to
wake every 50 ms; `kernel/loop_lag.ts`), and `checks` and `agents`, the
checks and crew runs running at the instant. The **Serving** starting board
draws the lag beside them.
`boards/ring.ts` keeps it in
`machine_sample`: 15-s points for 24 h and 5-min mean and max for 30 days,
dropping what leaves its window on every write. A file this machine lacks
leaves its series absent, never zero, and `/boards/data?source=machine`
names each one. Its rows belong to no repo, so only an every-repo scope
reads them; the sources list carries each column's unit in `docs`.

The `spawns` and `spawnTime` sources (admin only) read the one-click path's
events: `forge.spawn.started`, `forge.spawn.live` (`ms` since started, when the
child's `/healthz` first answers; `spawn/live.ts`) and `forge.spawn.failed`
(`step`: place, copy or health). A payload `drill: 1` makes it the `drill`
series, so the nightly drill never mixes into a person's numbers. The Forges
starting board shows forges made per day, p50/p95 time to live against the
3-minute budget, and failures by step. The watcher that waits for `/healthz`
lives in the process: a restart mid-spawn leaves a `started` with no outcome,
and that spawn is simply never counted live or failed. A retry of an
unfinished child appends its own `started`, so every `failed` has one. The
watchers poll every second, then every five after 30 seconds, stop when the
forge closes, and at most 20 run at once; a spawn past that is made, not timed.

The `stages` source counts items moving from issue to live: one row per
item entering a stage, with `stage` one of `1 issue` (opened), `2 run` (a
builder first started on the issue; a retry is not a second item), `3 pull`
(opened), `4 merged` (into the default branch) or `5 live` (a production
deploy served), and `at` when it entered. It is a fixed view over `issue`,
`run` and `pull` — the same moves `/flow` counts (`flow/throughput.ts`) —
and keeps no table of its own; the **Throughput** starting board reads it
by the hour.

    POST /api/v1/boards/query
    {"source": "runs", "aggregate": "count", "groupBy": "state"}
    -> {"rows": [{"group": "failed", "value": 1}, {"group": "ok", "value": 7}]}

## What is deliberately not here

Containers. A cell (rule 9) is namespaces and a watch, not an image: an
app runs the machine's own `bun` and tools, read-only, and its limits are
enforced by stopping it, not by throttling it — a container cannot create
the cgroups that would throttle. TLS
termination and an approve-and-land gate are additions of the same kind:
the shapes above hold, and a new column or listener carries each of them —
as one column carried a domain of the app's own.

## The `service` kind

`app.kind: "service"` in `forge.json` declares a long-running app that is not
an HTTP child: `ports` (TCP, 1024–65535, required), `always_on` (true; false is
refused), `placement` (`"metal"` or `"cloud"`, optional) and `volumes`
(`{ "path": "world", "sync": 300 }`, a relative path under the app's data and a
sync cadence in seconds, 10–86400). `src/apps/service.ts` validates it; the
manifest carries it as `service`, `null` for a web app. Running it, exposing
the ports and syncing volumes are not built yet (issue #391).

## The access log

The forge keeps one compact JSON line per request that is not a static asset
(or `/healthz`) under `<data>/access/access-YYYY-MM-DD.log`: time, host,
method, path without its query string (secret-looking segments blanked),
status, duration, user agent (200 characters), whether a credential came with
it, and a hash of the client address keyed with the data directory's secret
and the day. Lines are queued in memory and appended in one write a second (or per 200 lines), so a request pays for no disk write. No token, cookie or query string is ever written. Files go after
14 days, a day's file stops at 4 MB and the directory at 32 MB, oldest first.
Nothing serves the files. A forge admin reads the last day's non-browser
requests to public paths at Settings → Access, or with the `access` MCP tool
(`since`, `ua`, `path`; write-scope token).

## The forge as an OpenID Connect provider

Discovery is at `/.well-known/openid-configuration`. Register a client at
`/oauth/register`, send a person to `/oauth/authorize` with `scope=openid`
(optionally `profile email`), a `nonce`, and a PKCE S256 challenge. The
`/oauth/token` answer carries an `id_token` (ES256) beside the ordinary
ro/rw access token — the same grant, not a second credential. Present that
access token to `/oauth/userinfo` for the claims. `/oauth/jwks` publishes the
current signing key and the previous one; keys rotate every 30 days and live
in the database, never in the repository.

## Account spend ceilings

An account (a repository's owner: a person, an agent or an organization)
has a daily and a per-run model spend ceiling (`core/account_ceiling.ts`),
apart from the forge-wide one. An account has none until an admin sets them,
so no default ever stops a crew nobody chose to limit: on the account's page
under Settings → Accounts (an organization's too), in the terminal's **Model
ceiling** command, `POST /api/v1/admin/accounts/:name/ceiling`
(`{"dailyUsd": 20, "perRunUsd": 5}`) or the MCP `model_ceiling` tool. A run
that would pass either does not start and its message names the ceiling; one
under way stops at the day's. Spend is the
account's own repositories' usage today (UTC); another account's never counts.

### Egress connection caps

A cell may hold at most 8 open connections to one **granted private** destination (a device such as a Pi camera, so a leak cannot saturate it) and at most 64 to one **public** host (a package registry, which an install reaches with many parallel fetches). Past the cap the cell gets `429 Too Many Requests` and the forge logs `egress capped`.
