# A pull's looks

Looks are the pictures of a pull's preview: the forge's own once the deploy
is green, and the ones a person or agent attaches (`POST …/pulls/:number/looks`,
MCP `attach_look`). This is the read side, so an agent can check what it
attached.

One list, one rule (`pullLooks` in `src/looks/readable.ts`), three doors:

- **API** — `GET /api/v1/repos/:owner/:name/pulls/:number/looks` answers
  `{ items: [{ id, width, says, by, commit, url, at }] }`, newest first. `url`
  is the same one the POST answers. Beside `items` comes `fit`, for the pull's
  latest commit: one `{ page, width, scrollWidth, innerWidth, screens,
  sideways }` per page and width that has a stored size (`screens` =
  scrollHeight / innerHeight to one decimal, `sideways` = scrollWidth >
  innerWidth). Numbers only, no url, owner-taken looks included, for any
  reader of the pull; a sealed pull's `fit` is the writers'. Looks without a
  size are absent.
- **MCP** — the `pull` tool carries `looks`, the same items (no new tool).
- **Terminal** — `I` on a pull opens its looks; the pull screen's conversation also lists them under a `Looks` heading (none, no heading), each with its width, who, the line it says and the absolute URL on its own line. It is the same `pullLooks` read as the API and MCP, so a reader sees only what they may fetch.

Above the pictures on the pull page, and at the top of the terminal screen,
one line counts the pages shown beside main and those main has no picture of
(`4 pages beside main · 1 new to this pull`); when main has no pictures at all
it says so once. Both doors share the count in `src/looks/pairs.ts`.

Who sees what is `mayFetchLook`, the rule the pictures themselves use: a
reader who may not read the repository gets 404; a writer sees every look
that has a picture; anyone else sees only those taken as nobody, of an app
they may enter, and not those of a sealed pull. A look that failed (no
picture) is never listed. Only the pull's own preview environment is read, so
another pull's or app's looks never appear. A pull with no app or no looks
answers `items: []`.
