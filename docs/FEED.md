# The feed

A per-viewer read model of what happened on the forge, ranked, each item with
one sentence saying why it is there.

`GET /api/v1/feed?limit=&cursor=` → `{ items, next_cursor }`, for the signed-in
viewer only. An item is `{ id, kind, app, actor, at, link, what, reason,
score }`; `kind` is `run | ask | pull | decision | map | cost | tell | reply |
look`. `what` is the post in its own words; `reason` the sentence for why it
is there. Strings are plain text, not HTML: whatever renders them escapes
them. The MCP tool `feed { limit, cursor }` answers the same.

`POST /api/v1/feed/interactions` `{ item, kind, app? }` records what the viewer
did (`opened dwelled steered told swiped shipped shared dismissed muted`).
Same-origin checked for browser sessions, `rw` for tokens. An `event:` item
names its own repo and actor; any other item names its app as `owner/name`.
Anything the viewer cannot read is a 404.

## Where items come from (`src/feed/items.ts`)

- Events through `listEventsVisibleTo` then `audienceFilter`: `run.finished`
  (a deploy, check or agent run; a costly agent run is a `cost` item, shown
  only to those who may see owner facts), `pull.opened|merged|reviewed`,
  `look.taken` (a `look`: a full set of pictures), `app.serving`,
  `issue.blocked|unblocked` (map changes), `issue.opened` (a `tell`, in its
  title's words; see Bursts fold) and `issue.commented|pull.commented` (a `reply`, in its
  own words).
- Pending asks (`askLinesFor`), only for what the viewer may decide.
- Decision-ledger outcomes, only for repositories the viewer may write.
- The milestones the viewer watches (`core/watches.ts`), one `milestone`
  item each and only when there is something new: how far it is and what
  merged since they last opened it, that it landed, or that it was dropped
  or split. Its id carries its progress, so the item is replaced, never
  repeated, as the milestone moves. Not muted with its app.
- What froze on the viewer (#1090), read from what is true now: one
  `decision` item for each of their origins that needs re-authorizing with
  mirrors behind it ("octo at codeberg.org needs re-authorizing; 2 mirrors
  are frozen"), and one for each of their mirrors whose origin was
  disconnected ("alice/widgets is frozen; reconnect its origin"). Each goes
  the moment it is fixed (`docs/ORIGINS.md`, "When a token expires").

Runs already announce themselves on the outbox (`run.*`); looks did not, so
`look.taken` was added.

## Bursts fold (`src/feed/fold.ts`)

When one author opens 3 or more issues in one repository within 2 minutes,
`foldBursts` replaces them with one post, `planned N issues in owner/name`,
ranked where the newest would be and linking to the repository's map. The
first 3 titles ride on it as `lines` (`{ text, link }`), the rest as `more`;
the web card draws them as a `.list` of rows, MCP `feed` and
`GET /api/v1/feed` return them. One or two issues keep their own posts. The
fold runs after the viewer's filters and before paging, so chip counts and
cursors see the folded posts. A new kind of burst is a row in `FOLDS`.

## Ranking (`src/feed/rank.ts`, `affinity.ts`)

`score = urgency + 1.5·affinity + recency − repeats`. Urgency: asks 6–10, a
failed run 4. Recency halves every 6 hours. Affinity is a decayed count
(half-life 7 days) per app and per actor, seeded from ownership, pins, crew,
the viewer's own merges/proposals/tells and ledger outcomes, then moved by
interactions; a dismissal is −4, a mute −8 and hides the app. Each item
already placed from the same app costs 1.2, from the same actor 0.6.
The reason is the sentence for the largest term.

Muting hides an app's items except asks: what waits on a person is never
muted away. Dismissing hides one item. The cursor is `score|id` of the last
item; the feed is recomputed per request and resumes by id (or by score if
that item has gone).

## The page (`src/web/studio/feed.ts`)

`/` for a signed-in viewer is the feed (#599): the composer on top (a tell to
one of your apps; through the outbox to `POST /api/v1/feed/tells`, or `POST
/tell` without a script), then the first 20 items as posts, server-side; your
apps and what is on you in a narrow column on a desk, a tab away on a phone.
The app rows and the cost line are `/apps`. `/live/feed` answers the timeline
region for the live-regions client (etag, 304). A post: who did it, what it
says as a link into the thing, a small line of why, Steer (run
cards, posts to the run's `steer`) or Tell the crew (everything else, posts to
the app's `tell`), Dismiss and Mute app (the interactions API, same-origin).
Reply (#8211): a post whose link is an issue or a pull (`/:owner/:name/issues/:n`
or `/pulls/:n`) also offers Reply, a plain form posting the comment to that
page's own `/comments` handler with `back=feed`, so the same-origin check, body
limit and escaping apply; it returns to `/feed` with the flash "Reply posted."
(a fixed word, never a URL from the form); an empty or refused reply returns there too, with the reason. Reply is the card's one primary button; Tell drops to plain beside it. Only a signed-in viewer who can read
the repository sees it (`src/feed/reply.ts`, the comment action's own rule). In
the terminal, `Feed` in the palette lists the same posts and `r` replies through
the same `addCommentThrough`.
Keys: `j`/`k`/Enter are the shell's, `x` dismisses the focused card.
The `choose` card comes from `src/feed/choose.ts`, a run card offers Stop
(`src/web/studio/cards.ts`), and `?cursor=` pages past the first 20
(`src/web/studio/feed.ts`).

## Offline (`src/web/sw.ts`, `outbox.ts`)

- `/sw.js` (root scope, `no-cache`) keeps `/` network-first and serves the
  kept copy when the network fails, with `data-stale="1"` so the note above the
  feed says "Offline: this feed is from 12 min ago". The stylesheet, `/assets/*`
  and icons are cache-first. Nothing else is touched: the API, `/events`,
  `/live/*` and every POST go to the network. Signing out clears the cache and
  the outbox.
- Dismiss, mute, open and tell from a card go into an outbox in
  `localStorage` (200 at most), each with an `Idempotency-Key` made when it is
  queued, and are flushed on open, on `online` and after each add. No Background
  Sync (Safari has none). Entries leave on any 2xx or a final 4xx; a network
  error, 5xx, 408, 429 or 401 keeps them in order.
- Browser sessions now honour `Idempotency-Key` on `/api/v1/` mutations, scoped
  to the person (as tokens' are to the token): a replay returns the first
  answer. `POST /api/v1/feed/tells { app, text }` is the JSON tell the outbox
  sends. `from` (optional) is the page the tell was told from: a path on this
  forge, at most 512 characters; anything else is a 400 `invalid_from` and
  opens nothing. The issue reads "Told from <link>". `variants` (an integer, 1 to 4; anything else is a 400 and opens
  nothing) opens that many issues from the one tell, each handed to a builder
  run, all in one server-made group their pulls carry (`variant_group`), kept
  when a run is queued again. With more than one, the 201 also carries
  `issues` (the numbers opened), `assigned` (those handed to a builder) and
  `variantGroup`; a plain tell has none of the three.
- The live client reopens `/events?since=<last id>` when the browser gives up
  on the stream, and on `online`, and refreshes every region once.
- Not done: steering a run offline (a plain form post, needs the network),
  updating the kept `/` from live swaps (it is the page as last navigated),
  swipes (no swipe UI yet), push, and anything native.

## Sharing (`src/feed/share.ts`, `core/shares.ts`)

`POST /api/v1/share` `{ item, to? }` (`rw`, same-origin for sessions) and the
MCP tool `share` are one verb. `to` is up to 10 usernames. The sender must
see the item (it is looked up in the sender's own feed sources); the answer
is `{ sent: [{ to, outcome }] }`, outcome one of `delivered queued steered
told duplicate skipped unreachable`. A name that does not exist and one who
may not see the item are both `unreachable`.

- **No target:** the app's crew and owners (an org's writers and admins);
  only if none of those is someone else, the people who pinned the app
  (inside the org when an org owns it). A named target is always added.
- **No widening:** a recipient must `canRead` the repository and have the
  very item among their own candidates, or they are unreachable.
- **An agent** is steered (a comment on the change, when the item is one) or
  told (an issue routed to a builder) through the existing actions, as the
  sender, so the sender's own rights apply.
- **A person** gets a `share:` feed item with the reason "shared by X: …",
  boosted by `3 × sender weight`; it replaces the plain item. Their mute of
  the app makes the share `skipped`; dismissing the item hides the share.
- **Budget:** 5 delivered a day per person. More are queued, delivered
  best-weighted first as room frees (checked on each feed read), and dropped
  after 48 hours; a waiting share's worth falls linearly with its age.
- **Dedupe:** one share per item per recipient, ever.
- **Sender weight:** `2·(opens+1)/(shares+2)` over 90 days of delivered
  shares to people, clamped 0.2–2; an open is the recipient's `opened` of the
  item or its share. A sender nobody opens sinks, a trusted one rises.

## Clearing what is on you in one move

The home's one On you list (what asks you, and what is assigned to you) takes a
set: tick boxes, or *Select all*, a kind, or a repository, then one verb for
all of it — **close** (one `reason`, written on each as "Closed: …"),
**mute** (the repository goes quiet in your feed and On you; asks are never
muted away), **ship**, or on asks **decline** (dismiss) and hand back. It is
one `POST /api/v1/asks/bulk` (`action`, `items`, `reason`, `preview: false`);
`items` are ask ids (`assigned:<id>` for something assigned to you; `issue:<id>`
still names one). The list swaps in place and the top bar's count follows. One undo link
(`POST /api/v1/asks/bulk/<id>/undo`) is kept for a day. The MCP's `asks_act`
takes the same set, verb and reason.

## The composer keeps your draft

What you type in the home composer is saved in the browser's localStorage
(per signed-in user and page, at most once a second) and is back after a
reload. Sending clears it; a send the forge refuses puts the words back and
keeps them; signing out clears every draft. It lives in the feed's existing
script (no new script, no dependency). Not covered: the "the forge" thought
target posts as a plain form, so its draft is dropped on submit, and the
lean client home has no feed script, so no draft.

## Likes

A like is a signal (#7751): `POST /api/v1/feed/interactions` with `kind: "liked"` (or the form at `POST /feed/like`) toggles the viewer's `feed_like` row: pressing again deletes it, so a person counts once per item. An item of `GET /api/v1/feed` carries `likes` and `liked` once anyone likes it (absent means 0 and false), and every card draws a Like button with the count. A like does not move the ranking. An item the viewer cannot read is a 404, as for every act.

In the terminal, the Feed screen (`ssh` in, then Ctrl-K and "Feed") marks a liked post `♥ n` and one others like `♡ n`; `l` on the post under the cursor likes it and a second `l` takes it back. It runs the same `readInteraction` check and `toggleLike` as the page, and the write moves the forge's write clock, so web viewers see it on their next live refresh.
