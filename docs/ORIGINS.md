# Origins — one workbench over every forge

The forge is your index of everything you work on, wherever it lives. An
**origin** is a connected account on another forge (GitHub, Forgejo, Gitea).
From an origin you **mirror** repositories in; their issues, pulls, comments
and labels are imported alongside the git objects; and anything you do to
them here — comment, open, close, label, push a branch, open a pull — is
**written through** to the origin first and reflected locally after.

There is no standard for this above git. Git is the universal layer for
code; everything else is a thin per-forge adapter behind one `Provider`
interface (`src/origins/types.ts`). All forges share the same units, so the
adapters are small and boring, which is the point.

## Truth

- Native repo: **git is truth**, the database is an index (as before).
- Mirrored repo: **the origin is truth** — for git objects, issue numbers,
  states, labels and comments. Local rows are a cache with provenance
  (`origin_remote_id`, `origin_author`, `origin_html_url`, `synced_at`).
  Every write goes to the origin first; if the origin refuses, nothing
  changes here and the user sees the origin's reason.

Consequences: a mirrored repo's issue numbers equal the origin's; `#42` is
the same conversation on both sides. Local-only state on a mirror is a bug,
so the actions refuse it mechanically — `openIssue`, `addComment`,
`setIssueState` and `setIssueLabels` return `"mirrored"` on a mirror, and
their `…Through` twins are the path that works for both kinds of repo.

## Model (migrations 8 and 9)

```
origin        a connected account: kind, api_url, web_url, login, token_enc,
              auth_kind (pat|oauth), refresh_token_enc, expires_at, needs_reauth
origin_app    an OAuth application registered on one instance (per user)
oauth_flow    a connect in flight: a device poll, or a state+PKCE round trip,
              plus a short_code and the sealed target it redirects to
origin_repo   the origin's repo list, cached for the import picker
origin_cursor per-origin sync watermarks and the next-due / paused-until times
repo          + origin_id, origin_full_name, origin_remote_id, origin_html_url,
                last_fetch_at, fetch_error      (origin_id set ⇒ mirrored)
issue/comment + origin_remote_id, origin_author, origin_html_url, synced_at
label         + origin_remote_id
pull          + origin_head_repo
pin           (user, repo) — what the local client keeps cloned
```

Tokens are encrypted at rest (AES-256-GCM) with a key file the forge creates
in the data directory (`<data>/secret.key`, mode 0600 — the forge refuses to
boot if it is wider than that). The ciphertext is bound to its own row id as
additional authenticated data, so moving a row's token onto another origin
stops it decrypting. Tokens are never logged (`kernel/log.ts` scrubs
credential-shaped strings out of every line), never returned by any API,
never placed in a git URL or argv — git receives them through
`GIT_CONFIG_COUNT/KEY/VALUE` as an `http.<clone-url-origin>/.extraHeader`,
scoped to the one host and with redirects disabled.

Imported issues keep `author_id` = the connecting user so every join and
permission check keeps working, and carry `origin_author` (the login on the
origin) which both surfaces display in its place, with the origin's mark. The
connecting user owns the mirror, so "author-or-writer" checks resolving to
them is correct.

## Flows

**Connect.** Three ways in, and which one you get is a property of the forge
rather than a preference:

- **GitHub — the device grant** (RFC 8628). The forge shows a short code and
  a URL; you type the code into whatever device has a browser; the forge
  polls. This is the flow that works over SSH with no browser on the server.
  It needs only a public client id (`FORGE_GITHUB_CLIENT_ID`); a client
  secret is optional and only buys revoke-on-disconnect.
- **Forgejo / Gitea — authorization code with PKCE (S256).** They implement
  no device grant at all — their token endpoints accept only
  `authorization_code` and `refresh_token` — so the browser goes to the
  instance and comes back to `/settings/origins/callback`. Every instance
  needs its own application registration, so the user pastes a client id
  once per host (`POST /api/v1/user/origin-apps`); a public client is fine,
  and PKCE is mandatory for one.
- **A pasted token**, still, as the fallback that needs no registration
  anywhere.

Both OAuth flows end with a URL somebody has to open on a device that has a
browser, which over SSH is a string that can be neither clicked nor reliably
copied. So a flow also carries a **short link**: ten Crockford-base32
characters of crypto randomness on the row, redirected by `GET /go/<code>`
(migration 10). That route is deliberately anonymous — the phone typing it has
never signed in here and the target is a public page — and it answers only
while the flow is pending and unexpired; an unknown code and a dead one give
the same 404, byte for byte. The target is sealed at rest like every other
secret in that table, because a code flow's authorize URL carries the `state`,
and it is never written to a log. Both surfaces render the link as a QR code
(`src/design/qr.ts`, zero dependencies) beside the link itself; the terminal
also offers OSC 52 copy, which reaches the user's own terminal rather than the
server's clipboard.

Discovery: `github.com` is known by name. Otherwise `GET /api/v1/version` —
NodeInfo is the one thing here resembling a standard and no live Forgejo
serves it, so it is only an opportunistic first probe. The version string is
the discriminator: `16.0.1+gitea-1.22.0` is Forgejo declaring the Gitea API
generation it implements; a bare version is Gitea. GitHub Enterprise
publishes neither, so the user names it (`kind: "github"` with a host →
`/api/v3`). `whoami()` then validates the credential and fixes `login`.

Discovery fetches a host a stranger named, so it is https-only, refuses
private address literals and non-http schemes, follows no redirect off-host,
caps the body at 64 KB and times out in 5 s. An operator can vouch for a LAN
or plaintext host with `FORGE_ORIGIN_ALLOW=host[,host…]`; there is no
per-user toggle, because the risk it accepts belongs to the server.

**Refresh.** A Forgejo OAuth access token lives about an hour, so it is
refreshed a minute before it expires rather than after a 401. Refreshes are
serialised per origin — two in parallel against a rotating provider spend the
token twice, and the loser presents one the winner already invalidated — and
the new pair is written before the new access token is used. `invalid_grant`
and `unauthorized_client` (Forgejo's answer to a replayed refresh token) are
both terminal: the origin is marked `needs_reauth`, an `origin.needs_reauth`
event is appended, and sync skips it until a human reconnects.

**Pick, then look, then decide.** `listRepos` fills `origin_repo`; the picker
shows every remote repo, and each row says whether we already mirror it
(`mirroredAs`). Opening one does **not** mirror it: it **browses** it live,
read-only, through the origin's own API — README, tree, files, branches,
tags, commits with diffs, issues, pulls, comments, labels — with a banner
saying where you are. Mirroring is then a deliberate second act with visible
progress. Enter used to mean "clone this and import all of it", which took
seconds with nothing on screen and made looking at a repository cost the
same as adopting one.

**Browse.** One interface, `RepoSource` (`src/view/source.ts`), answers every
repo screen's questions; two implementations answer them. `localSource` reads
`git/read.ts` and the core tables exactly as the pages do today.
`originSource` reads a `Provider` and shapes the answers into the same values
— a remote tree entry becomes the `TreeEntry` `ls-tree` yields, a remote blob
becomes the three states `blobForRender` yields, a remote commit becomes
git's `Commit` with the origin login beside the name. So a screen renders a
`RepoSource` and never asks which one it holds. `sourceFor(app, actor, ref)`
picks the implementation and enforces access in one place: `canRead` for a
local repo, and **the origin's owner and nobody else** for a live browse,
because the browse spends their credential on another forge. Both refusals
are `not_found` (invariant 9).

Nothing on `RepoSource` writes, in either implementation — `capabilities`
tells a surface which buttons to draw, and the absence of methods is what
makes read-only mechanical rather than promised. What the origin does not
offer, the source does not invent: a live browse reports no issue counts
(neither forge gives both cheaply) and no mergeability, as `null` rather than
a guess, and a label or author filter narrows the page in hand rather than
pretending the origin searched.

Live reads are cached per process (`src/view/cache.ts`), keyed by origin,
repo, method and arguments: 60 seconds for a moving target (branches, lists,
a ref's log), 10 minutes for anything addressed by an object id, which cannot
change. Bounded by entry count and by the bytes of the blobs among them —
an LRU without a byte budget is a memory leak with good manners. Conditional
requests live a layer below, in `ApiClient`'s ETag cache, so a miss here is
often still a 304 there. The mirror job and the sync worker `bust` a repo's
keys the moment the truth upstream moves.

Blobs are capped at 1 MB and diffs at 2 MB before the request is made, not
after: browsing a stranger's repository must cost a bounded amount of memory
whatever it holds. Over the cap a blob is `too_large` with no body, which is
also what the API returns (413), exactly like the local contents route.

**Mirror.** Mirroring creates a local repo under the user's namespace (name
collisions get a `-<host>` suffix), configures a bare repo with explicit
refspecs, fetches, installs hooks, imports labels, then issues and pulls
(with comments and reviews). Visibility follows the origin's — a private or
Forgejo-`internal` repo becomes private here.

It runs as a **job** (`src/origins/jobs.ts`): `startMirror` returns
immediately with `{ id, originId, fullName, stage, detail, startedAt,
finishedAt?, repo?, error? }`, and the work reports its way through
`creating → fetching → labels → issues → pulls → comments → done`, with a
detail line ("42 issues") from the import itself — there is one place that
knows how far an import has got, and it is the import. `subscribe(jobId, cb)`
feeds a live UI (and the SSE route); `settled(jobId)` is what a caller that
just wants the repository waits on. A second start for the same remote joins
the running job rather than beginning a second clone. Failures land on the
job (scrubbed) and in `fetch_error`, never thrown — the work is detached from
any request, so a rejected promise would take the process with it. The
registry is in memory on purpose: progress is not state worth persisting, and
a job row that outlived its process would be a lie about it. What is durable
is what always was — the repo row, `repo.mirrored`, `push`, and `repo.imported`.

**Sync.** A worker tick (beside the delivery worker) picks origins due for a
sync (default every 10 minutes, or on demand). Per mirrored repo:
`git fetch --prune` with the origin's auth env; refs that moved emit a `push`
event with `via: "origin"` so webhooks, SSE and the activity feed see
upstream activity; then incremental `listIssues(since = watermark − 5 min)`
for issues and pulls, upserting by `origin_remote_id`, and comments/reviews
for each _changed_ item. The watermark is when the run started (not the
newest `updated_at` seen) and it advances only on a clean run, so a failure
mid-sweep is a re-fetch rather than a hole. Conditional requests and both
rate-limit header dialects (`X-RateLimit-*` and RFC 9331 `ratelimit`) are
honoured; a rate-limited origin is skipped until `retryAt`. Failures land in
`last_error` / `fetch_error`, visible in both surfaces, never thrown into the
loop.

**Write-through.** On a mirrored repo `openIssueThrough`, `addCommentThrough`,
`setIssueStateThrough`, `setIssueLabelsThrough` and `openPull` call the
provider first, then upsert the returned item locally (so the number and
timestamps are the origin's), then append the usual event marked
`via: "origin"`. **Only the person who connected the origin may write through
it** — any other local writer gets `origin_owner_only`, because their comment
would otherwise appear upstream under someone else's identity with someone
else's token. Sharing a mirror's write access across a team wants an explicit
per-repo opt-in and a delegation model; that is deliberately not v1. Merging
a pull on a mirror is refused (`mirrored`): merge on the origin, and the next
sync brings back the merge commit it actually made.

**Push-through.** A mirrored repo accepts pushes from the account that
connected its origin — the push travels under that credential, so nobody
else may send it (the same `origin_owner_only` rule as write-through). In
**pre-receive** — before the local refs move — the forge pushes each updated
ref to the origin with the stored credential; if the origin refuses, the
local push is refused with the origin's own message. This is possible because
the pushed objects are still in the push's quarantine directory and git tells
the hook where it is (`GIT_QUARANTINE_PATH` and friends, already forwarded by
`git/hook-protocol.ts`); handing those to `git push` lets pack-objects build
the upstream pack from the quarantine. Doing it in post-receive instead would
mean accepting objects the origin then rejects, leaving the mirror silently
ahead of its origin — the exact divergence this feature exists to prevent.

Every push names an explicit refspec and an explicit
`--force-with-lease=<ref>:<oldoid>` (the three-part form is the only
non-experimental one, and the only one our own background fetcher cannot
defeat). `refs/pull/*` never travels. `remote.origin.mirror` is pinned false
and a refspec-less push is refused by the helper, because
`remote.<x>.mirror=true` silently turns `git push` into `push --mirror`:
force everything and **delete upstream any ref missing locally**. Multi-ref
pushes go `--atomic`, so an origin that would take one ref and refuse another
takes neither. Once an origin is disconnected its mirrors fail closed: they
stay readable and stop syncing, and a push is refused with the reason until
the origin is reconnected.

**Visibility narrows only.** A repo that goes private upstream goes private
here on the next sweep, at once. One that goes public upstream stays as it
was: widening is the owner's decision to make here, never an origin's.

**Fork-less contributions** (no push rights): v2 — `forkRepo` on the origin,
push there, open the pull with `owner:branch`. Held back because whether
Forgejo's `POST /pulls` accepts the `owner:branch` head form is unverified,
and it gates the whole flow.

**Pins.** `pin` rows say which repos the user wants on their machine. The
local client (`src/cli/`) reads them over the API, clones under
`~/src/<host>/<owner>/<repo>`, keeps them fetched, and reports
ahead/behind/dirty. The server never knows local state.

## API

```
GET    /go/:code                               anonymous: 303 to a live flow's
                                               verification/authorize URL
GET    /api/v1/user/origins                    list (no tokens, ever)
POST   /api/v1/user/origins                    {host|kind, token}  → discovers, validates
POST   /api/v1/user/origins/oauth              {host|kind} → starts device OR code flow
GET    /api/v1/user/origins/oauth/:id          poll a flow (the forge does the polling)
DELETE /api/v1/user/origins/:id                → { revokedUpstream }
POST   /api/v1/user/origins/:id/sync           sync now
GET    /api/v1/user/origins/:id/repos          the picker (cached, ?refresh=1)
                                               each row: mirroredAs {owner,name}|null

  browsing a remote repo live — B = …/origins/:id/browse/:owner/:name
GET    B                                       facts + branches + readme
GET    B/branches   B/tags   B/labels
GET    B/tree/:ref[/*path]                     one level: {type:"dir",ref,path,entries}
GET    B/blob/:ref/*path                       {type:"file",…,encoding,content} | 413
GET    B/commits?ref=&cursor=                  {items, next_cursor}
GET    B/commits/:oid                          commit + parsed diff
GET    B/issues  B/pulls  ?state=&label=&author=&q=&cursor=
GET    B/issues/:number   B/pulls/:number      + body, comments, pull facts

POST   /api/v1/user/origins/:id/mirror         {fullName, name?} → 202 {job}
GET    /api/v1/user/origins/:id/mirror/:job    poll one job
GET    /api/v1/user/origins/:id/mirror/:job/stream   SSE: mirror.<stage>, ends on done
GET    /api/v1/user/origin-apps                registered OAuth apps (no secrets)
POST   /api/v1/user/origin-apps                {host, clientId, clientSecret?}
DELETE /api/v1/user/origin-apps/:id
POST   /api/v1/repos/:o/:n/sync                sync this mirror now
GET    /api/v1/user/pins  PUT/DELETE /api/v1/user/pins/:owner/:name
```

Everything under `/api/v1/user/origins` and `/api/v1/user/origin-apps` needs
the **account**: a same-origin session, the password, or an explicit `admin`
token. A `ro` or `rw` token is refused — otherwise a leaked repo-write token
escalates into "read this person's GitHub credentials by proxy". That covers
the browse routes too: they read another forge with this account's
credential, which is the same authority as spending it. Repo-level sync and
pins take the ordinary `rw` floor.

Repo JSON gains `origin: { kind, fullName, htmlUrl, lastFetchAt, fetchError } | null`
and `pinned: boolean`; issue/comment JSON gain `originAuthor`, `originUrl`;
pull JSON gains `originHeadRepo`. Errors specific to this surface:
`mirrored` (409), `origin_owner_only` (403), `origin_refused` (409),
`origin_unreachable` (502), `origin_unauthorized` (502, the origin refused
our credential — reconnect it), `rate_limited` (429) and `too_large` (413) —
so a client can tell "the forge said no" from "the origin said no", and
"come back later" from "this will never work".

Events added: `origin.connected`, `origin.refreshed`, `origin.needs_reauth`,
`origin.disconnected`, `origin.app_registered`, `repo.mirrored`,
`repo.imported`, `repo.pinned`, `repo.unpinned`. Imported activity reuses the
existing kinds (`push`, `issue.opened`, `pull.opened`, `pull.merged`,
`issue.commented`, …) with `via: "origin"` in the payload. None of them ever
carries token material, a `state`, or a `code`.

## Known limits

- **Write-through is inline, not queued.** The request waits on the origin
  (bounded by a 20 s API timeout). A durable job queue would decouple them
  and make retries idempotent; it would also mean a comment that appears
  "pending", which is a worse lie than a slow request. Revisit if a slow
  origin becomes the common case.
- **Comments are fetched per changed item**, not through the repo-wide
  `/issues/comments?since=` sweep both forges offer. Correct, and O(changed)
  rather than O(all) — but the repo-wide sweep is one request instead of N
  and is the obvious next optimisation.
- **A live browse cannot search.** Neither forge offers a label/author/title
  filter both spell the same way on a list endpoint, so those narrow the page
  we fetched. Fine for a look; the mirror is what makes a repo searchable.
- **Fetch progress is stage-level, not percentages.** `git fetch --progress`
  writes them to stderr, but `runGitCapture` buffers stderr whole; streaming
  it wants a spawn path of its own, and "fetching git objects" was worth more
  than that today.
- **No LFS.** A mirror of an LFS repo has the pointers, not the objects.
- **Key rotation is not built.** The sealed blob carries a `v1` version tag
  so it can be, but losing `secret.key` today means reconnecting the origins.
- **DNS rebinding is not closed.** The SSRF policy checks address _literals_;
  a hostname that resolves into a private range still gets through, because
  pinning the resolved address needs a connect hook Bun's `fetch` does not
  expose. The operator allow-list is the mitigation.
- **Milestones, reactions, projects, and GitLab** are out of scope. The
  adapter shape fits GitLab; it is one more file when wanted.
