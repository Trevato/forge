# The explorer's sorts (#7753)

`/explore`, `GET /api/v1/explore`, the MCP tool `explore` and the terminal's search line (`/`, then a line with `kind:` or `sort:`) are one action, `explore` in `src/actions/explore.ts`. The line is `kind:app sort:likes updated:7d owner:name archived:yes words`.

`sort:` takes one of:

| sort | ranks by |
|---|---|
| `score` (default) | the front page's score: forks, ships, use and freshness at the admin's weights, plus a modest lift for likes |
| `forks` | public forks by people |
| `ships` | pulls merged in the last 30 days |
| `likes` | likes on posts about the app |
| `use` | hours awake in the last 30 days |
| `fresh` | the last merge |
| `name` | A to Z |

The page's tabs are Best, Forks, Shipped, Liked, Use and Fresh; a row shows `N likes` when N > 0, on the web and in the terminal.

## How likes count

A like is a `feed_like` row (one per person and post, `src/feed/likes.ts`). An app's count is the likes on posts about its repository, read only for repositories the viewer may read: a private app's likes are never in a public row, and a stranger never sees the private app at all. A person's count is the sum over the apps shown to the viewer.

In `score`, likes add `0.5 × ln(1 + likes)`, small next to forks (3) and ships (2). The weight is a constant in `explore.ts`, not one of the front page's admin weights.

An unknown `sort:` word is a 422 naming the sorts above (see the end of this page).

When an unknown `kind:`, `sort:`, `updated:` or `archived:` value is within edit distance 2 of a known one (and nearer than the value is long, so one or two characters of junk suggest nothing), the note ends with `Did you mean <a>sort:forks</a>?`, a link to the whole line with that word mended. Only the first such word is mended per line; a word repeated is mended everywhere. `GET /api/v1/explore` and the MCP `explore` tool carry the same as `suggest` (`"garden sort:forks"`, the whole corrected line), absent when there is none. The terminal shows it as plain text under "Read as:". It is a pure function of the line: nothing is looked up.

## One word on every surface (#10387)

What a person filters on `/explore` an agent filters with the same words: the `q` line. The page's chips are plain links to `/explore?q=<line>`; the API takes the same line as `?q=`, the MCP tool as the argument `q`.

| the page offers | the line | API `GET /api/v1/explore` | MCP `explore` |
|---|---|---|---|
| Best / Forks / Shipped / Liked / Use / Fresh | `sort:score` `forks` `ships` `likes` `use` `fresh` (`name` by hand) | `?q=sort:forks` | `{ q: "sort:forks" }` |
| All / Apps / People / Forges (admin) | `kind:app` `kind:person` `kind:forge` | `?q=kind:app` | `{ q: "kind:app" }` |
| Any time / Today / This week / This month | `updated:1d` `7d` `30d` | `?q=updated:7d` | `{ q: "updated:7d" }` |
| Show archived | `archived:yes` | `?q=archived:yes` | `{ q: "archived:yes" }` |
| (owner link on a row) | `owner:name` | `?q=owner:name` | `{ q: "owner:name" }` |

The three return the same ordered rows (`test/explore-parity.test.ts`).

An unknown filter word is refused the same way everywhere: `422` from the API (`{ "error": "unknown_filter", "message": "sort:bogus is not a sort — use score, forks, …", "suggest"? }`), an `unknown_filter` error from the MCP tool, and `422` on the page, which still draws the note, the did-you-mean link and the results. This replaces the earlier note-only answer (#7595).
