# Origins — one workbench over every forge

The forge is your index of everything you work on, wherever it lives. An
**origin** is a connected account on another forge (GitHub, Forgejo, Gitea).
From an origin you **mirror** repositories in; their issues, pulls, comments
and labels are imported alongside the git objects; and anything you do to
them here — comment, open, close, label, push a branch, open a pull — is
**written through** to the origin first and reflected locally after.

There is no standard for this above git. Git is the universal layer for
code; NodeInfo (`/.well-known/nodeinfo`) is the standard that tells us a
host runs Forgejo or Gitea; everything else is a thin per-forge adapter
behind one `Provider` interface (`src/origins/types.ts`). All forges share
the same units, so the adapters are small and boring, which is the point.

## Truth

- Native repo: **git is truth**, the database is an index (as before).
- Mirrored repo: **the origin is truth** — for git objects, issue numbers,
  states, labels and comments. Local rows are a cache with provenance
  (`origin_remote_id`, `origin_author`, `origin_html_url`, `synced_at`).
  Every write goes to the origin first; if the origin refuses, nothing
  changes here and the user sees the origin's reason.

Consequences: a mirrored repo's issue numbers equal the origin's; `#42` is
the same conversation on both sides. Local-only state on a mirror is a bug.

## Model (migration 8)

```
origin        a connected account: kind, api_url, web_url, login, token_enc
origin_repo   the origin's repo list, cached for the import picker
origin_cursor per-origin sync watermarks (ETags, updated_at)
repo          + origin_id, origin_full_name, origin_remote_id, origin_html_url,
                last_fetch_at, fetch_error      (origin_id set ⇒ mirrored)
issue/comment + origin_remote_id, origin_author, origin_html_url, synced_at
label         + origin_remote_id
pull          + origin_head_repo
pin           (user, repo) — what the local client keeps cloned
```

Tokens are encrypted at rest (AES-256-GCM) with a key file the forge
creates in the data directory (`<data>/secret.key`, mode 0600). They are
never logged, never returned by any API, and never placed in a git URL or
argv — git receives them through `GIT_CONFIG_COUNT/KEY/VALUE` as an
`http.extraHeader`.

Imported issues keep `author_id` = the connecting user so every join and
permission check keeps working, and carry `origin_author` (the login on
the origin) which both surfaces display in its place, with the origin's
mark. The connecting user owns the mirror, so "author-or-writer" checks
resolving to them is correct.

## Flows

**Connect.** The user pastes a host (or picks GitHub) and a personal
access token. Discovery: `github.com` is known; otherwise
`/.well-known/nodeinfo` → `software.name`; fallback `/api/v1/version`.
`whoami()` validates the token and fixes `login`. Stored encrypted.

**Pick.** `listRepos` fills `origin_repo`; the picker shows every remote
repo with a toggle. Mirroring one creates a local repo under the user's
namespace (name collisions get a `-<host>` suffix), runs
`git clone --mirror`-equivalent fetch into the bare dir, installs hooks,
imports labels, then issues and pulls (with comments and reviews).
Visibility follows the origin's.

**Sync.** A worker tick (with the delivery worker) picks origins due for a
sync (default every 10 minutes, or on demand). Per mirrored repo:
`git fetch --prune` with the origin's auth env; refs that moved emit a
`push` event with `via: "origin"` so webhooks, SSE and the activity feed
see upstream activity; then incremental `listIssues(since = watermark
with overlap)` for issues and pulls, upserting by `origin_remote_id`, and
comments/reviews for each changed item. Labels are re-listed per sync.
Conditional requests and rate-limit headers are honoured; a rate-limited
origin is skipped until `retryAt`. Failures land in `last_error` /
`fetch_error`, visible in both surfaces, never thrown into the loop.

**Write-through.** On a mirrored repo the actions `openIssue`,
`addComment`, `setIssueState`, `setIssueLabels`, `openPull` call the
provider first, then upsert the returned item locally (so the number and
timestamps are the origin's), then append the usual event. Merging a pull
on a mirror is not offered in v1 (merge on the origin; the next sync
reflects it).

**Push-through.** A mirrored repo accepts pushes from writers. In
pre-receive the forge pushes the updated ref to the origin with the stored
credential (`git push <clone_url> <old>:<ref>` semantics via
`--force-with-lease` where the old oid is known); if the origin refuses,
the push is refused with the origin's message. The local ref then matches
the origin without waiting for the next fetch. Result: `git clone` from
the workbench, work, `git push` — and it lands upstream; then open the
pull from the terminal or the browser and it is created upstream.

**Fork-less contributions** (no push rights): v2 — `forkRepo` on the
origin, push there, open the pull with `owner:branch`.

**Pins.** `pin` rows say which repos the user wants on their machine. The
local client (`src/cli/`) reads them over the API, clones under
`~/src/<host>/<owner>/<repo>`, keeps them fetched, and reports
ahead/behind/dirty. The server never knows local state.

## API

```
GET    /api/v1/user/origins                    list (no tokens)
POST   /api/v1/user/origins                    {host|kind, token}  → discovers, validates
DELETE /api/v1/user/origins/:id
POST   /api/v1/user/origins/:id/sync           sync now
GET    /api/v1/user/origins/:id/repos          the picker (cached, ?refresh=1)
POST   /api/v1/user/origins/:id/mirror         {fullName, name?}   → local repo
POST   /api/v1/repos/:o/:n/sync                sync this mirror now
GET    /api/v1/user/pins  PUT/DELETE /api/v1/user/pins/:owner/:name
```

Repo JSON gains `origin: { kind, fullName, htmlUrl, lastFetchAt, fetchError } | null`
and `pinned: boolean`; issue/comment JSON gain `originAuthor`, `originUrl`.

## Not here

Two-way sync of edits made on the origin to local-only fields (there are
none). Milestones, reactions, projects. GitLab (the adapter shape fits; it
is one more file when wanted). Federation (ForgeFed) — watch Forgejo.
