# Moving a repository to another owner

From the terminal: on a repository's screen, `:` then "Move this repository
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

Not yet: git remotes under the old path, runs and previews follow in the next
step.
