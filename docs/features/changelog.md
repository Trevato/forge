# Changelog

`GET /changelog` is public. It lists the last 30 `Release <version>: …` commits on the default branch of the forge's own repository (`FORGE_REPO`), newest first. Each has a heading anchored `#<version>`, its date, and one link per pull named in the subject (`title (#N);title (#N)`). When `FORGE_REPO` is unset or its repository is private, the page answers 200 with "No releases yet". The footer links to it.

The terminal's palette has `Changelog`, the same read for anyone, a guest included. `/` takes a word and keeps only releases whose version or carried pull titles contain it, ignoring case; the header says how many match, and `esc` clears it. Enter on a release lists its pulls (`#N title`); a release whose subject names none shows "No pulls". Enter on a pull opens it, as Enter does on any pull.

One bounded `git log` read, cached per head oid; Server-Timing names `releases` and `render`.

## What went live (#7672)

`/changelog` lists the pulls merged into a default branch, newest first, grouped by UTC day: title, link, repository, when it landed. A pull to the forge's own repository (`FORGE_REPO`) counts only once the running commit (`FORGE_COMMIT`, the one `/api/v1/health` reports; the default branch head for a forge run from source) contains its merge commit, asked of git with `merge-base --is-ancestor` and kept while live. Landed but not yet contained shows above as "On its way". A pull to any other public repository is live when it lands. The top line says the live version and commit and how many shipped today. `?repo=all` or `?repo=owner/name` filters; the forge's own repository is the default.

The list is a live region (`pull.merged`, `app.serving`): it swaps in place without a reload. MCP `releases` with `{shipped: true}` answers the same list to anyone. The "no release" alarm reads the same record (`release/landings.ts`), refreshed each minute, and is silent until a read has happened. The older `Release <version>: …` commit read (`release/changelog.ts`) now serves only the terminal's Changelog screen.

## Reads like a story (#10837)

Titles are shown plain (`plainTitle` in `story/gather.ts`): a leading `small:` and any `test/…` or `src/…` path are dropped, and a first plain word is capitalised (`j/k` is left as written). The pull keeps its real title on its own page. Within one UTC day, landings whose titles share a shape (the same words with one slot of up to three words changing, at least three words shared) gather into one line such as "j/k, enter, esc and ? on …", with the count and who built them said once; on the page the line is a `<details>` (a focusable `<summary>`, no script) that opens to each pull. A title naming a revert or a security fix is never gathered. The terminal's release pulls gather the same way (Enter on a gathered line lists its pulls), and `/changelog.atom` uses the plain titles. `/api/v1/changelog` keeps the raw titles.

## Credit (#9181, #10259)

A squash keeps the people behind its commits: the landed message carries every distinct `Co-authored-by` its commits carried and each commit's author, except the crew's agents (`@agents.invalid`), once per address. `/changelog` then shows "With Jay Moran" on a row for everyone credited on the landed commit beyond whoever landed it (`creditsOf` in `git/coauthors.ts`, one git read, kept per commit); a landing with no one else shows nothing. Only the forge's own repository is read. A row also says who built it: "By Scout" is the author of the landed commit, "With Claude Sonnet 5.5" the names in its trailers (less the committer and the author), both as plain facts under the title, from the same one git read (`buildersOf`). At most the newest 80 landings of the forge's own repository are asked of git, and at most 500 commits are remembered, oldest dropped first. `GET /api/v1/changelog` carries `by` and `with` on a landing that has them. In the terminal, Enter on a release lists its pulls, and a pull the forge landed shows "by Scout, with Claude Sonnet 5.5" beside it. 

## For agents

`GET /api/v1/changelog` is the page's list as JSON, public, cached five seconds: `{version, commit, live, onItsWay}`, each landing `{repo, number, title, at, live[, with]}`. `?repo=all` or `?repo=owner/name` filters; the default is the forge's own repository, as on the page. MCP `releases` with `{shipped: true, repo?}` and `GET /api/v1/releases?shipped=true[&repo=]` answer the same rows with the same default. Only public repositories are read; concurrent requests share one read of git and the merged rows, so an anonymous caller costs no more than a page view. The page links the JSON with `rel="alternate"`. The terminal's Changelog screen is the release-commit view (`release/changelog.ts`); it does not show the landings list.

## As a feed (#8213)

`GET /changelog.atom` is the same list as an Atom feed, public, for a feed reader. It holds the newest 50 live landings of the forge's own repository (`FORGE_REPO`, public only), one entry each titled `Went live: <title>` and linked to its pull; what has landed but is not yet live is left out. The 50 is the feed's own cap (`CHANGELOG_ENTRIES` in `web/feeds.ts`); the page and `/api/v1/changelog` are not capped. It is cached for five minutes (`cache-control: public, max-age=300`) and carries a weak `ETag`, so a reader that sends `If-None-Match` gets a 304. The page links it with `rel="alternate"`.

An agent reads the same data as JSON, not Atom: MCP `releases` with `{shipped: true}` or `GET /api/v1/changelog` (see above). The terminal has no screen for the feed, since a feed is for a reader program; its Changelog screen is the release-commit view.
