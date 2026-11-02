# Changelog

`GET /changelog` is public. It lists the last 30 `Release <version>: …` commits on the default branch of the forge's own repository (`FORGE_REPO`), newest first. Each has a heading anchored `#<version>`, its date, and one link per pull named in the subject (`title (#N);title (#N)`). When `FORGE_REPO` is unset or its repository is private, the page answers 200 with "No releases yet". The footer links to it.

The terminal's palette has `Changelog`, the same read for anyone, a guest included. `/` takes a word and keeps only releases whose version or carried pull titles contain it, ignoring case; the header says how many match, and `esc` clears it. Enter on a release lists its pulls (`#N title`); a release whose subject names none shows "No pulls". Enter on a pull opens it, as Enter does on any pull.

One bounded `git log` read, cached per head oid; Server-Timing names `releases` and `render`.

## What went live (#7672)

`/changelog` lists the pulls merged into a default branch, newest first, grouped by UTC day: title, link, repository, when it landed. A pull to the forge's own repository (`FORGE_REPO`) counts only once the running commit (`FORGE_COMMIT`, the one `/api/v1/health` reports; the default branch head for a forge run from source) contains its merge commit, asked of git with `merge-base --is-ancestor` and kept while live. Landed but not yet contained shows above as "On its way". A pull to any other public repository is live when it lands. The top line says the live version and commit and how many shipped today. `?repo=all` or `?repo=owner/name` filters; the forge's own repository is the default.

The list is a live region (`pull.merged`, `app.serving`): it swaps in place without a reload. MCP `releases` with `{shipped: true}` answers the same list to anyone. The "no release" alarm reads the same record (`release/landings.ts`), refreshed each minute, and is silent until a read has happened. The older `Release <version>: …` commit read (`release/changelog.ts`) now serves only the terminal's Changelog screen.
