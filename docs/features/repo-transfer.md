# Moving a repository to another owner

From the web: a repository's Settings page has a "Move to another owner" block
(an admin's, beside Archive): type the new owner, confirm, and you land on
Settings at the new path. A refusal comes back beside the field as its
sentence, the field kept; anyone who does not administer the repository gets
`404`. From the terminal: on a repository's screen, `:` then "Move this repository
to another owner", and type the new owner. From the API:
`POST /api/v1/repos/:owner/:name/transfer` with `{"newOwner": "<account or org>"}`
moves a repository (an `rw` token; the caller administers the repository and
may create repositories under the new owner — themselves, or an org they can
write to). It is refused when the new owner already has a repository by that
name.

What moves: the repository row's owner and the bare repository on disk, in
one step — the directory is renamed back if the database write fails.
Everything keyed by the repository (its app, secrets, crew, autonomy,
direction, issues and pulls) travels with it; a fork's link to its objects is
rewritten. Nothing else on disk is named by owner/name: an app's data lives
under its app id, crew checkouts and install caches under the repository's
id, and mirrors under its id, so none of them move. Moves run one at a time,
so two moves to the same owner/name cannot both pass the checks.

Who moved what from where to where is kept twice: an audit row in
`repo_transfer`, written in the move's own transaction and never rewritten,
and a `repo.transferred` event for the repository's readers.

The event appears in their feed (and the dashboard, which shares it) as one
line, "moved from alice/demo to acme/demo", linking to the new path. Someone
who cannot read the repository never sees it.

Old paths keep working: a web or API request under the old `owner/name`
answers `308` to the same path under the new owner, for reads and writes
alike (a write is never applied silently; the client re-sends it). Someone
who cannot read the repository still gets `404`. Making a new repository at
the old path takes the path back.

Git over HTTPS follows too: `GET /<old-owner>/<name>.git/info/refs?service=git-upload-pack`
answers `308` to the new owner for someone who may read the repository, so
`git clone` and `git fetch` on an old remote reach the new one (git follows the
redirect on its first request). A push to the old URL is never applied: it is
refused with `403` and a sentence naming the new path and the `git remote
set-url` to run. Someone who cannot read it gets what a missing path answers.
Over SSH the old path is not redirected (SSH has no redirect): the remote must
be updated to the new path.

Not yet: runs and previews follow in the next step.

For 30 days after a move, the repository's page says where it came from: one
muted line, "Moved from alice/demo on 2026-11-09", under the head, for someone
arriving by an old link. The terminal says the same on the About card (`I` on
the repository's screen) as a "moved from" row. Both read the newest
`repo_transfer` row through `recentMove` in `src/core/transfer.ts`; after 30
days, or for a repository never moved, neither shows anything.
