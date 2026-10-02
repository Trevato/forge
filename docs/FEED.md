# The feed

A per-viewer read model of what happened on the forge, ranked, each item with
one sentence saying why it is there.

`GET /api/v1/feed?limit=&cursor=` → `{ items, next_cursor }`, for the signed-in
viewer only. An item is `{ id, kind, app, actor, at, link, reason, score }`;
`kind` is `run | ask | pull | decision | map | cost`. Strings are plain text,
not HTML: whatever renders them escapes them.

`POST /api/v1/feed/interactions` `{ item, kind, app? }` records what the viewer
did (`opened dwelled steered told swiped shipped shared dismissed muted`).
Same-origin checked for browser sessions, `rw` for tokens. An `event:` item
names its own repo and actor; any other item names its app as `owner/name`.
Anything the viewer cannot read is a 404.

## Where items come from (`src/feed/items.ts`)

- Events through `listEventsVisibleTo` then `audienceFilter`: `run.finished`
  (a deploy, check or agent run; a costly agent run is a `cost` item, shown
  only to those who may see owner facts), `pull.opened|merged|reviewed`,
  `look.taken` (new: a full set of preview pictures), `app.serving`,
  `issue.blocked|unblocked` (map changes).
- Pending asks (`askLinesFor`), only for what the viewer may decide.
- Decision-ledger outcomes, only for repositories the viewer may write.

Runs already announce themselves on the outbox (`run.*`); looks did not, so
`look.taken` was added.

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

`/` for a signed-in viewer renders the first 20 items as cards above the shelf,
server-side, and `/live/feed` answers the same region for the live-regions
client (etag, 304). A card: the reason as a link into the thing, Steer (run
cards, posts to the run's `steer`) or Tell the crew (everything else, posts to
the app's `tell`), Dismiss and Mute app (the interactions API, same-origin).
Keys: `j`/`k`/Enter are the shell's, `x` dismisses the focused card.
Not yet: the `choose` deck card (nothing in the feed produces one), stop from
a card, and paging past the first 20.
