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
              + fork_of: `owner/name` this remote repo forks (getRepo only)
origin_cursor per-origin sync watermarks and the next-due / paused-until times
repo          + origin_id, origin_full_name, origin_remote_id, origin_html_url,
                last_fetch_at, fetch_error      (origin_id set ⇒ mirrored)
              + origin_fork_of: the upstream `owner/name` this mirror forks
              + origin_detached_at: when its origin went (mig. 72; trigger)
              + require_review (0/1): the merge gate                (mig. 13)
issue/comment + origin_remote_id, origin_author, origin_html_url, synced_at
label         + origin_remote_id
pull          + origin_head_repo
review        a verdict on a pull: state, body, commit_oid, and for an
              imported one origin_remote_id + origin_author        (mig. 13)
review_thread (issue, anchor) → resolved_at, resolved_by           (mig. 13)
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
the origin is reconnected ("When a token expires", below).

**Visibility narrows only.** A repo that goes private upstream goes private
here on the next sweep, at once. One that goes public upstream stays as it
was: widening is the owner's decision to make here, never an origin's.

**The fork flow** — contributing to a repository you cannot push to. One
call, `contribute` (`src/actions/contribute.ts`), because it is one
intention: _grab their repo, branch, edit, propose it back_. Split across
five round trips it becomes five half-finished states — a fork with no
mirror, a mirror with no branch, a branch with no commit, a commit nobody
proposed.

What it does, in order:

1. **Ask the origin what you may do.** `getRepo(upstream).permissions.push`
   decides the shape. With push rights nothing is forked: the branch is
   created on the upstream's own mirror and travels there by push-through,
   like any other branch on a mirror.
2. **Find or make your fork.** `forkOrigin` is idempotent: a fork of this
   upstream the account already has is returned as-is (found through
   `origin_repo.fork_of`, or by asking for the conventional name and
   checking its `parent`). GitHub answers a repeat `POST /forks` with the
   existing fork and Forgejo answers 409, so the check has to be ours for
   both to behave alike.
3. **Wait for it.** GitHub creates a fork _asynchronously_ and answers 202
   with a repository that 404s if you ask immediately. `forkOrigin` polls
   `getRepo` with backoff (250 ms → 3 s) for up to 30 s.
4. **Mirror your fork.** That is the workbench: you cannot commit into a
   repository you cannot push to, and the mirror's row remembers the
   upstream in `origin_fork_of`.
5. **Start the branch from the UPSTREAM's base**, not the fork's copy of it.
   A fork made months ago is a snapshot, and committing on top of it
   proposes a diff full of work somebody already merged. `fetchRefFrom`
   (`origins/git-mirror.ts`) fetches the upstream's base ref into the fork's
   mirror with the origin's credential and names no local ref; the branch
   starts at that commit. This is `git fetch upstream` with the manual step
   removed.
6. **Commit, through push-through.** `createBranch` then `editFiles`: the
   objects are written locally, the origin is asked, and the local ref moves
   only if it agreed — the ordinary mirror rule, unchanged.
7. **Open the pull on the UPSTREAM**, with the cross-repository head form
   `head: "<forkOwner>:<branch>"`. Both forges take it. If we also mirror the
   upstream, the created pull is imported so there is a local row; if we do
   not, the number and the origin's URL come back and that is the whole
   truth there is.

**A fork of a mirror** — refining work here before it goes out. A mirror
is the origin's; every push through it lands upstream at once. A native
fork of a mirror (`Fork` on the mirror's page) is the opposite: git is
truth in it and nothing done there reaches the origin. That makes it a
workbench in front of the outside world: the crew forks _it_ and proposes
into it, the person merges there — as many pulls as it takes — and then
proposes the result to the mirror as one pull. Opening that pull
(`headRepo` = the fork, base = the mirror) carries the fork's branch to
the origin first, under the connecting account's credential with the lease
the mirror holds for that branch, exactly as a push through would
(`carryBranchThrough` in `src/origins/push-through.ts`); the origin opens
the pull from the branch it now holds, and the mirror's own copy of the
branch follows. The fork's default branch is refused as a head: carried
up, it would land on the origin's default branch itself, a push rather
than a proposal — propose a branch made for it. Meanwhile the fork follows
the mirror: each sync that moves the mirror's default branch fast-forwards
the fork's, so long as nothing was committed on it directly (`docs/APPS.md`,
"Forks follow their parents").

The `owner:branch` form is verified against the fakes in
`test/fork-flow.test.ts` (both dialects, with real git behind them) and it
matches both forges' documented shape. **It has not yet been run against a
live Forgejo instance**, and that is the one thing worth doing before
leaning on it: Forgejo's `head` is an undocumented plain string, and a real
instance is the only thing that can settle whether it resolves the owner the
way GitHub does.

**Review states.** A review is a _verdict_ on a pull at one commit —
`approved`, `changes_requested` or `commented` — stored in `review` beside
the line comments, which stay in `comment` with `kind='review'`. Two rules
are mechanical: a verdict that carries authority (approve, request changes)
takes **write** access, so "require review" cannot be satisfied by anyone who
can merely read the repo; and **you cannot approve your own** pull.

The gate is `repo.require_review`: `mergePull` refuses `review_required`
unless there is an approval **of the current head** and no request for
changes on it. A verdict carries the `commit_oid` it was passed on, so a push
dismisses it without anything having to remember to — new code is new code.
A request for changes on the current head blocks a merge whether or not an
approval was ever required; one passed on an older head does not.

Threads are the resolution unit: every review comment sharing an anchor is
one conversation, addressed by `anchorId(path, side, line)` — a 16-hex digest,
because the key itself contains a NUL and a path and belongs in no URL. A
writer, or anyone who commented in the thread, may resolve or unresolve it.

On a mirror the origin decides all of it. A verdict is submitted there —
GitHub `POST /pulls/{n}/reviews {event: APPROVE|REQUEST_CHANGES|COMMENT}`,
Forgejo the same path with its own nouns `{event: APPROVED|REQUEST_CHANGES|
COMMENT}` — and imported back keyed on the origin's review id. Sync brings in
everyone else's (`listReviewStates`, one request per changed pull, separate
from the line-comment walk that costs one request per review). `PENDING` and
`DISMISSED` are not verdicts and are dropped rather than mapped to one.
Imported verdicts are collapsed per **origin login**, not per local author id:
every imported row is attributed locally to the connecting user, so keying on
that would turn five reviewers into one.

**Pins.** `pin` rows say which repos the user wants on their machine. The
local client (`src/cli/`) reads them over the API, clones under
`~/src/<host>/<owner>/<repo>`, keeps them fetched, and reports
ahead/behind/dirty. The server never knows local state.

## When a token expires

A credential dies: a token is revoked, a refresh token is spent, an OAuth
grant expires. The origin is marked `needs_reauth`, and its mirrors stop
syncing — they are **frozen**, still attached, waiting. Settings → Origins
says so on the origin ("2 mirrors are frozen until it is re-authorized") with
a **Re-authorize** link, and the owner's feed carries one decision item.
Re-authorizing is connecting the same account again: the forge finds the
origin that lost its credential and puts the new one on the same row, in
place (`renewOrigin`). Its id does not change, so its mirrors never detach;
a sync starts at once.

The other way out is to disconnect the origin and connect it again — which
is what happened live in #1090. Disconnecting deletes the origin row, and the
schema's `ON DELETE SET NULL` takes `repo.origin_id` with it while the
provenance stays (`origin_full_name`, `origin_remote_id`, `origin_html_url`).
That is a **detached mirror**: frozen like the first kind, but with no origin
left to sync through, and `push-through.ts` refuses every push to it ("reconnect
the origin before pushing") because accepting one would let it drift from an
upstream it still claims. A trigger on that foreign key's `SET NULL` records
the moment in `repo.origin_detached_at` (migration 72); `last_fetch_at` is
when it froze.

**What a person sees.** The repository home and its branches page carry one
quiet block: "This repository mirrors `octo/widgets` at codeberg.org, but
that origin was disconnected on 2026-10-11; it has been frozen since
2026-10-02." Every reader gets the sentence. An admin of the repository also
gets the **Reconnect** form — a select of their own working origins on the
same host and a button — or, when they have none there, the link to
Settings → Origins to connect one. Settings → Origins lists the account's
frozen mirrors and where each came from, and the feed asks the owner to
reconnect each one. A fork following a detached mirror never says it is up
to date with it (`docs/FOLLOWING.md`).

**The one click** is `reattachMirror` (`src/actions/origins.ts`), behind the
form (`POST /:owner/:name/settings/origin/reconnect`) and the API. It
re-attaches only when all of these hold, and says which one did not:

- the repository is a detached mirror (`not_detached`);
- the actor administers it and owns the origin — anything else is
  `not_found`, because reconnecting lends that origin's credential to every
  later sync and push of the mirror;
- the origin lives on the host the mirror came from, read from the
  remembered page or, failing that, the bare repository's git remote
  (`wrong_host`);
- that account can see the repository by the name the mirror remembers
  (`origin_cannot_see`), it is the same repository (`not_the_same_repo`: a
  name deleted and made again upstream is someone else's history, and a sync
  would prune this one into it), and no other repository here already
  mirrors it (`already_mirrored`).

Then the remote is remembered, the repo is linked again (which clears
`origin_detached_at`), the bare repository's remote URL is rewritten if the
clone URL changed, `origin.mirror_reattached` is appended (for the repo's
admins), and a sync starts in the background so the refs move now — the
answer says "syncing", and the mirror's branches follow within seconds.

**Connecting again re-attaches by itself.** After any connect — a token, a
device grant, a code flow — the forge looks for the detached mirrors the
person owns whose host is the new origin's, and re-attaches each with the
same routine. Owns, not administers: re-attaching lends that account to
every later sync and push, so an organization's mirror borrowing an admin's
personal account is that admin's click on Reconnect, never a side effect of
connecting. A refusal never fails the connect: the answer lists
every mirror it tried, re-attached or not and why
(`reattached: [{ owner, name, fullName, refused }]`, `refused` null for one
that came back), and the page's flash says "Reconnected 1 mirror:
trevato/forge-upstream".

Two rules keep a reconnect honest. The origin must be on the same **site** as
the mirror's remembered page — scheme, host and port — because `git.example`
and `git.example:8443` are two servers, and a mirror reattached across them
would sync from the wrong one. And a mirror made before the forge kept the
origin's id for it is not reconnected (`remote_unknown`): it cannot be told
apart from a repository made again under the same name, and a sync would
prune its history into the newcomer's; mirror it again instead.

## Migrate — bringing a repository here for good

A mirror keeps answering to its origin. A **migration** does not: it is a
one-time clone of the whole history into a native repository that is yours
from the first second. No `origin_id`, no remote in its config, no
write-through; after it, this forge is where the repository lives. It is
the "+" menu's **Migrate** (`/migrate`), and `migrateRepo`
(`src/actions/migrate.ts`) is the whole act.

**The source** is one of two things. A repository on one of your origins,
picked from the same list the mirror picker reads (`listRemoteRepos`), is
cloned with that origin's credential — the auth header in the environment,
scoped to its host (`origins/credentials.ts`), never in argv, the URL or the
repository's config — so private ones come too. Or a pasted URL, cloned
anonymously: public repositories only. A URL is `https://`, `http://` or
`git://` and nothing else — `file://`, `ssh://`, `ext::`, a leading `-` and a
URL carrying a password are refused before anything exists, and
`GIT_ALLOW_PROTOCOL` pins the transports again at the fetch in case a
redirect has other ideas. `github.com/a/b` gets the `https://` a person meant.

**The clone** fetches every branch and tag — the mirror's explicit
refspecs, never `--mirror` (every `refs/pull/*`, and a remote marked for
push-mirroring) and never `--single-branch` — straight from the URL, with no
remote configured, under a 120-second wall-clock cap. The source's default
branch is kept (asked with `ls-remote --symref`); a source that never says
keeps the forge's `main`, else `master`, else its first branch. One `push`
event with `via: "migrate"` announces what arrived, so the feed, webhooks
and the default branch's check see it like any push. Everything a person
can get wrong — the URL, the owner, the name (collision-checked like any new
repository), the agent — is refused in words before the repository exists;
what is left for the job is the network. A clone that fails removes the
empty repository it made, so the name is free to try again.

**Put a crew on it.** Name an agent and, after the clone, the same job puts
it on the crew, makes the repository an app, sets it autonomous when asked,
and `tell`s the crew one thing: make it run here. The brief is the
importer's — adapt, don't rewrite: declare `run` and `health` in
`forge.json` (and `install`/`test` when the repository has them), listen on
`PORT`, keep persistent state under `FORGE_APP_DATA`, keep behaviour, no
Dockerfile and no compose file (the forge runs processes), and write down
what could not fit. The crew proposes; a person lands — autonomy included,
exactly as for any app (docs/APPS.md).

The clone runs as a job in the mirror's registry (`origins/jobs.ts`, kind
`migrate`, owned by whoever started it — anyone else's is `not_found`).
`/migrate/jobs/:job` refreshes until it stops, then lands on the repository
with what happened as the flash.

## API

```
GET    /go/:code                               anonymous: 303 to a live flow's
                                               verification/authorize URL
GET    /api/v1/user/origins                    list (no tokens, ever)
POST   /api/v1/user/origins                    {host|kind, token}  → discovers, validates
                                               → 201 origin + reattached [{owner,name,
                                                 fullName,refused}]; renews in place
                                                 an account that needs re-auth
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

POST   /api/v1/user/origins/:id/fork           {fullName} → 202
                                               {remote, existed, job, mirroredAs}
POST   B/contribute                            the fork flow, from a browse
POST   /api/v1/repos/:o/:n/contribute          the fork flow, from a mirror
POST   /api/v1/user/origins/:id/mirror         {fullName, name?} → 202 {job}
GET    /api/v1/user/origins/:id/mirror/:job    poll one job
GET    /api/v1/user/origins/:id/mirror/:job/stream   SSE: mirror.<stage>, ends on done
GET    /api/v1/user/origin-apps                registered OAuth apps (no secrets)
POST   /api/v1/user/origin-apps                {host, clientId, clientSecret?}
DELETE /api/v1/user/origin-apps/:id
POST   /api/v1/repos/:o/:n/sync                sync this mirror now
POST   /api/v1/repos/:o/:n/origin/reconnect    {originId} → repo JSON; re-attach a
                                               detached mirror (admin token, repo
                                               admin, own origin; else 404/422 code)
GET    /api/v1/user/pins  PUT/DELETE /api/v1/user/pins/:owner/:name

POST   /api/v1/migrate                         {source: {url} | {originId, fullName},
                                                owner?, name?, visibility?,
                                                crew?: {agent, autonomous}}
                                               → 202 {repo, job}
GET    /api/v1/migrate/:job                    poll one migration (its starter only)
GET    /api/v1/migrate/:job/stream             SSE: migrate.<stage>, ends on done
```

Everything under `/api/v1/user/origins` and `/api/v1/user/origin-apps` needs
the **account**: a same-origin session, the password, or an explicit `admin`
token. A `ro` or `rw` token is refused — otherwise a leaked repo-write token
escalates into "read this person's GitHub credentials by proxy". That covers
the browse routes too: they read another forge with this account's
credential, which is the same authority as spending it. Repo-level sync and
pins take the ordinary `rw` floor; so does a migration from a URL, while one
from an origin takes `admin` — it spends the origin's credential. Its
refusals are 422 `{ error, message }`: `invalid_url`, `no_such_origin`,
`unreachable`, `no_such_agent`, and the new-repository codes (`name_taken`,
`invalid_name`, `forbidden_owner`).

A contribute answers 201 with
`{ via: "fork"|"direct", repo: {owner,name}, forkFullName, branch, commit,
pull: { number, htmlUrl, local } | null }` — `repo` is where the branch landed
here, `forkFullName` the fork at the origin (null on the direct path), and
`pull.local` the imported row when we mirror the upstream too. Its refusals
are the ordinary origin codes plus `fork_timeout` (504 — the origin took the
request and the fork has not appeared), `mirror_failed` (502) and the edit
codes `editFiles` already returns.

Review states and threads, on any repo:

```
GET    /api/v1/repos/:o/:n/pulls/:n/review-states   the verdicts
POST   /api/v1/repos/:o/:n/pulls/:n/review-states   {state, body?, comments?} → 201
POST   /api/v1/repos/:o/:n/pulls/:n/approve-here   a writer lets an origin fork's current head run here → 201
GET    /api/v1/repos/:o/:n/pulls/:n/threads         anchors + resolution
POST   /api/v1/repos/:o/:n/pulls/:n/threads/:anchor/resolve
DELETE /api/v1/repos/:o/:n/pulls/:n/threads/:anchor/resolve
PATCH  /api/v1/repos/:o/:n                          {requireReview}
```

`…/reviews` is unchanged and still the _line comments_ — a sibling path
rather than a mode of the same one, because a comment on a line and a verdict
on a change are different things with different rules, and one path meaning
two of them behind a query parameter is the shape that gets called wrong.
Each line comment now carries `anchor`, the thread it belongs to.

A review that comes with line comments is still one call: `comments` on
`…/review-states` is a list of `{path, line, side, body}`, at most 50, posted
before the verdict and all or none — one anchor outside the diff refuses the
whole review with `bad_anchor`, and the message says how an anchor is written.
This is the one way the crew's reviewer brief posts a review.
`GET …/pulls/:number` gains `status.reviews:
{ approved, changesRequested, required, mergeable }`.

Repo JSON gains `origin: { originId, kind, fullName, htmlUrl, host, lastFetchAt,
fetchError, detached, frozenSince, detachedAt } | null` — a detached mirror
keeps an `origin` with `detached: true`, `originId` and `kind` null, and the
times it was disconnected and last fetched, so it never passes for a native
repository — and `pinned: boolean`; issue/comment JSON gain `originAuthor`, `originUrl`;
pull JSON gains `originHeadRepo`. Errors specific to this surface:
`mirrored` (409), `origin_owner_only` (403), `origin_refused` (409),
`origin_unreachable` (502), `origin_unauthorized` (502, the origin refused
our credential — reconnect it), `rate_limited` (429) and `too_large` (413) —
so a client can tell "the forge said no" from "the origin said no", and
"come back later" from "this will never work".

Events added: `origin.connected`, `origin.refreshed`, `origin.needs_reauth`,
`origin.disconnected`, `origin.app_registered`, `origin.mirror_reattached`
(on the repo, for its admins: `{ origin, fullName }`), `repo.mirrored`,
`repo.imported`, `repo.pinned`, `repo.unpinned`, `repo.forked`
(`via: "origin"` for a fork made at an origin), `pull.reviewed` (with
`state` for a verdict, `path`/`line` for a line comment) and
`pull.thread_resolved`. Imported activity reuses the
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
- **The `owner:branch` head form is unverified against a live Forgejo.** It
  is exercised against the fake in both dialects and matches the documented
  shape; Forgejo's own `head` is an undocumented plain string. Try it against
  a real instance before relying on it in anger.
- **Contributing needs a workbench.** `contribute` mirrors your fork (and, on
  the push-rights path, the upstream) if it is not mirrored already, so the
  first contribution to a large repository pays for a clone and an import.
- **A review's line comments do not travel with its verdict.** Submitting a
  review through the origin sends the state and the body; anchored comments
  are still posted one at a time. Both forges accept comments inside the
  review payload, which is the obvious next step.
- **Key rotation is not built.** The sealed blob carries a `v1` version tag
  so it can be, but losing `secret.key` today means reconnecting the origins.
- **DNS rebinding is not closed.** The SSRF policy checks address _literals_;
  a hostname that resolves into a private range still gets through, because
  pinning the resolved address needs a connect hook Bun's `fetch` does not
  expose. The operator allow-list is the mitigation.
- **Milestones, reactions, projects, and GitLab** are out of scope. The
  adapter shape fits GitLab; it is one more file when wanted.
