# Changelog

`GET /changelog` is public. It lists the last 30 `Release <version>: …` commits on the default branch of the forge's own repository (`FORGE_REPO`), newest first. Each has a heading anchored `#<version>`, its date, and one link per pull named in the subject (`title (#N);title (#N)`). When `FORGE_REPO` is unset or its repository is private, the page answers 200 with "No releases yet". The footer links to it.

The terminal's palette has `Changelog`, the same read for anyone, a guest included. `/` takes a word and keeps only releases whose version or carried pull titles contain it, ignoring case; the header says how many match, and `esc` clears it. Enter on a release lists its pulls (`#N title`); a release whose subject names none shows "No pulls". Enter on a pull opens it, as Enter does on any pull.

One bounded `git log` read, cached per head oid; Server-Timing names `releases` and `render`.

## What went live (#7672)

`/changelog` lists the pulls merged into a default branch, newest first, grouped by UTC day: title, link, repository, when it landed. A pull to the forge's own repository (`FORGE_REPO`) counts only once the running commit (`FORGE_COMMIT`, the one `/api/v1/health` reports; the default branch head for a forge run from source) contains its merge commit, asked of git with `merge-base --is-ancestor` and kept while live. Landed but not yet contained shows above as "On its way". A pull to any other public repository is live when it lands. The top line says the live version and commit and how many shipped today. `?repo=all` or `?repo=owner/name` filters; the forge's own repository is the default.

The list is a live region (`pull.merged`, `app.serving`): it swaps in place without a reload. MCP `releases` with `{shipped: true}` answers the same list to anyone. The "no release" alarm reads the same record (`release/landings.ts`), refreshed each minute, and is silent until a read has happened. The older `Release <version>: …` commit read (`release/changelog.ts`) now serves only the terminal's Changelog screen.

## Credit (#9181)

A squash keeps the people behind its commits: the landed message carries every distinct `Co-authored-by` its commits carried and each commit's author, except the crew's agents (`@agents.invalid`), once per address. `/changelog` then shows "· with Jay Moran" on a row for everyone credited on the landed commit beyond whoever landed it (`creditsOf` in `git/coauthors.ts`, one git read, kept per commit); a landing with no one else shows nothing. Only the forge's own repository is read. `GET /api/v1/changelog` carries the same names as `with` on a landing that has them. The terminal's Changelog screen is the release-commit view and does not list landings, so it shows no credit.

## For agents

`GET /api/v1/changelog` is the page's list as JSON, public, cached five seconds: `{version, commit, live, onItsWay}`, each landing `{repo, number, title, at, live[, with]}`. `?repo=all` or `?repo=owner/name` filters; the default is the forge's own repository, as on the page. MCP `releases` with `{shipped: true, repo?}` and `GET /api/v1/releases?shipped=true[&repo=]` answer the same rows with the same default. Only public repositories are read; concurrent requests share one read of git and the merged rows, so an anonymous caller costs no more than a page view. The page links the JSON with `rel="alternate"`. The terminal's Changelog screen is the release-commit view (`release/changelog.ts`); it does not show the landings list.

## As a feed (#8213)

`GET /changelog.atom` is the same list as an Atom feed, public, for a feed reader. It holds the newest 50 live landings of the forge's own repository (`FORGE_REPO`, public only), one entry each titled `Went live: <title>` and linked to its pull; what has landed but is not yet live is left out. The 50 is the feed's own cap (`CHANGELOG_ENTRIES` in `web/feeds.ts`); the page and `/api/v1/changelog` are not capped. It is cached for five minutes (`cache-control: public, max-age=300`) and carries a weak `ETag`, so a reader that sends `If-None-Match` gets a 304. The page links it with `rel="alternate"`.

An agent reads the same data as JSON, not Atom: MCP `releases` with `{shipped: true}` or `GET /api/v1/changelog` (see above). The terminal has no screen for the feed, since a feed is for a reader program; its Changelog screen is the release-commit view.
