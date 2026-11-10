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

When an unknown `kind:`, `sort:`, `updated:` or `archived:` value is within edit distance 2 of a known one (and nearer than the value is long, so one or two characters of junk suggest nothing), the note ends with `Did you mean <a>sort:forks</a>?`, a link to the same view with that word mended (in the parameter form below, `/explore?sort=forks`). Only the first such word is mended per line; a word repeated is mended everywhere. `GET /api/v1/explore` and the MCP `explore` tool carry the same as `suggest` (`"garden sort:forks"`, the whole corrected line), absent when there is none. The terminal shows it as plain text under "Read as:". It is a pure function of the line: nothing is looked up.

## One word on every surface (#10387)

What a person filters on `/explore` an agent filters with the same words. Each filter is its own parameter: the page's chips are plain links like `/explore?kind=app&sort=forks` (the default view is bare `/explore`, and only the free words stay in `q`), so a filtered view is a link that reloads the same (#10727). The API takes the same parameters, and the MCP tool the same names as arguments.

| the page offers | the parameter | API `GET /api/v1/explore` | MCP `explore` |
|---|---|---|---|
| Best / Forks / Shipped / Liked / Use / Fresh | `sort=score` `forks` `ships` `likes` `use` `fresh` (`name` by hand) | `?sort=forks` | `{ sort: "forks" }` |
| All / Apps / People / Forges (admin) | `kind=app` `person` `forge` | `?kind=app` | `{ kind: "app" }` |
| Any time / Today / This week / This month | `updated=1d` `7d` `30d` | `?updated=7d` | `{ updated: "7d" }` |
| Show archived | `archived=yes` | `?archived=yes` | `{ archived: "yes" }` |
| (owner link on a row) | `owner=name` | `?owner=name` | `{ owner: "name" }` |
| the search box | `q=words` | `?q=words` | `{ q: "words" }` |

The one line still works everywhere: `?q=kind:app sort:forks garden` and `{ q: "kind:app sort:forks garden" }` read the same as the separate parameters, and old `/explore?q=…` links keep working. When a parameter and the same key in `q` are both given, the parameter wins (`?q=sort:name&sort=forks` sorts by forks). A parameter's value is one word; one the explorer does not take is an unknown word like any typed in `q`, and is refused the same way (below). The terminal's search line takes only the line.

The three return the same ordered rows (`test/explore-parity.test.ts`; the URL form in `test/explore-url.test.ts`).

An unknown filter word is refused the same way everywhere: `422` from the API (`{ "error": "unknown_filter", "message": "sort:bogus is not a sort — use score, forks, …", "suggest"? }`), an `unknown_filter` error from the MCP tool, and `422` on the page, which still draws the note, the did-you-mean link and the results. This replaces the earlier note-only answer (#7595).

## Make it yours on an app row
An app's row carries `action: { do: "make_it_yours", label: "Make it yours" }` exactly when `copyable` is true (`MAKE_IT_YOURS` in `actions/explore.ts`).
`label` is the page button's text and `do` is the name of the MCP tool that forks; it plans unless called with `dryRun: false`.

## As a feed (#10967)

`GET /explore.atom` is `/explore` as an Atom feed, public, for a feed reader. It holds the apps `/explore` ranks first for a stranger (default ranking, apps only, read through the page's own `explore`), at most 30 (`EXPLORE_ENTRIES` in `web/feeds.ts`), shown newest-made first, one entry each titled with the app's name, linked to its page (`rel="alternate"`) with its description as the summary. Private and archived apps are never in it. It is cached for five minutes (`cache-control: public, max-age=300`) and carries a weak `ETag`, so a reader that sends `If-None-Match` gets a 304. `/explore` links it with `<link rel="alternate" type="application/atom+xml">`. Server-Timing names `read` and `render`.

The terminal's palette has `Explore feed`, which opens or shows the feed's address (copy it into a reader).
