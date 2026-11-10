# Feed likes: the ledger

A like is a row of `feed_signal` (who, item, act, when), the same for a person and an agent. `feed_like` is the current state, moved in the same transaction by `setLike` (`src/feed/likes.ts`).

## Use it

- Page: the Like button on a card (`POST /feed/like`, `act` = `like` | `unlike`).
- API: `POST /api/v1/feed/interactions` with `kind: "liked"` or `"unliked"` (`rw` token).
- MCP: `feed_like` with `act` = `like` | `unlike` | `history`.
- Terminal: Feed screen (Ctrl-K, "Feed"): `l` likes or takes back, `h` lists the post's ledger, `m` reads older rows, `esc` closes.
- Read it back: `GET /api/v1/feed/likes?item=event:…[&before=seq]` answers `{ item, ledger: [{ seq, who, act, at }], more }`, newest first, 50 a page. Pass the last row's `seq` as `before` while `more` is true. MCP `history` takes the same `before`.

## Decisions

- Asking for the state already held writes nothing. Unlike is a new row; nothing is edited or deleted.
- Flipping like/unlike grows the ledger, one row a flip. The ordinary per-token rate limit bounds the rate, and reading is paged, so a busy item never hides its recent acts.
- **Every liker's username is shown to anyone who may read the item, on purpose.** A like is a public act on a post, as a comment is. An item the caller cannot read is a 404.
- Every door runs the same `readInteraction` check; anonymous callers get 401 naming `/signin`.

## Left out

Pruning old ledger rows, and hiding likers from other readers.
