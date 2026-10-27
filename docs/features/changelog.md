# Changelog

`GET /changelog` is public. It lists the last 30 `Release <version>: …` commits on the default branch of the forge's own repository (`FORGE_REPO`), newest first. Each has a heading anchored `#<version>`, its date, and one link per pull named in the subject (`title (#N);title (#N)`). When `FORGE_REPO` is unset or its repository is private, the page answers 200 with "No releases yet". The footer links to it.

The terminal's palette has `Changelog`, the same read for anyone, a guest included. `/` takes a word and keeps only releases whose version or carried pull titles contain it, ignoring case; the header says how many match, and `esc` clears it. Enter on a release lists its pulls (`#N title`); a release whose subject names none shows "No pulls". Enter on a pull opens it, as Enter does on any pull.

One bounded `git log` read, cached per head oid; Server-Timing names `releases` and `render`.
