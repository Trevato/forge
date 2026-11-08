# A forge is an origin (#8900, first piece)

Connect another forge at `/settings/origins`: type its address and press "Sign in there". A token it gave you (Settings, Tokens there; `ro` is enough to bring code across) is the path for when sign-in is unavailable. `discover` asks `GET /api/v1/version`; a forge answers `{"version", "software":"forge"}` (a 0.5.x forge has no such route, and is known by `/api/v1/health` with its OAuth metadata), and is stored as an origin with `software = forge` (kind `gitea`, the dialect it speaks).

- **Picker:** `GET /api/v1/user/repos` lists the token's account's repositories, private ones included, in the Gitea shape. Only that route speaks the Gitea shape; a repository's own JSON is unchanged.
- **Credential:** the token travels as `Authorization: Bearer …` for the API, the one scheme every release of a forge reads (one older than `/api/v1/version` answers `token …` with 401), and as Basic through `GIT_CONFIG_*` for git — never argv, never config.
- **Mirror:** brings the code and its history, and the issues, pulls, comments and labels, read in the forge's own JSON (`src/origins/providers/forge-work.ts`) with the real author kept. A bring whose first fetch failed is finished by asking again. The origin's card and `GET /api/v1/user/origins` (`carries`) say what did not come: how the app runs (not yet), and its data and secrets (never by default).
- **Write-through:** a comment, an issue or a state change here goes to the other forge first, with the connecting person's token (`rw` needed), and is refused with nothing changed here when the forge is down or says no. A pull is opened there with `createPull` (the contribute path); its merge comes back with the next sync.

Measured against an older forge and itself, in containers: [the compatibility matrix](forge-origin-compat.md), `scripts/forge-compat-lab.sh`.

## Sign in with one click (#8902)

Type the friend's address at `/settings/origins` and press "Sign in there". If the address is a forge, this forge registers itself there (`POST /oauth/register`, RFC 7591, a public client, kept per user and host), then sends the browser to its approval page with PKCE and the scope `ro` — the least that brings code across. The friend sees who asks and what for, picks the lifetime, and the browser returns to `/settings/origins/callback`. No client id or token is copied. A sign-in begun from `/bring` keeps its link on the flow (`return_query`) and carries straight on with the bring; a callback reaching a browser signed out here signs in and resumes, its state unspent.

- **Refresh:** pick a lifetime other than "Until I revoke it" and the friend's forge issues a rotating refresh token; this forge refreshes before expiry. A spent one (`invalid_grant`) marks the origin needs-reauth, as on every other kind. A token that never expires carries no refresh token and needs none.
- **Registration is per callback address:** if this forge's public URL changes, forget the app and connect again.
- Test: `test/forge-origin-oauth.test.ts` runs two forges through the whole flow.

Not yet: review and check state coming back live, guest rules for a crew on the receiving side, following upstream with one action.

Not yet, in order: migrate an app whole with its run and build, follow upstream between forges with a pull back, and the one-page paste-a-link path. Test: `test/forge-origin.test.ts` runs two forges against each other.

## Issues and comments both ways (#8967)

On a brought repository an issue or comment opened here is written to the origin as the connected account (`src/origins/write-through.ts`), then reflected here under the origin's own number and id.

- **Webhook:** the origin's issues, comments and pulls arrive by a signed delivery to `/api/v1/repos/:owner/:name/origin-hook` (`src/origins/hook.ts`). It is believed for nothing but "look again": the named issue and its thread are read from the origin (`item-check.ts`; a pull goes to `pull-check.ts` and is never imported as an issue). If the origin cannot be read the delivery is refused (404) so it is sent again.
- **Catch-up:** the sync sweep fetches whatever moved since its last clean run, so after the origin was down nothing is lost. Comments are keyed on the origin's id, so a webhook, a sweep and the echo of our own write are one row.
- **Registration:** the hook is asked for once, when a mirror is first imported (and after a pull is proposed upstream), and only a forge origin can be asked. Making a hook takes `admin` scope there, so a `ro` or `rw` token, and every sign-in, registers none and relies on the sweep; a GitHub or Gitea origin does too. Asking is idempotent (the origin's hooks are listed first, none is added twice).
- Test: `test/origin-issues.test.ts` runs two forges through write, webhook and catch-up.

## Both doors, and what was exercised

The terminal reaches the same code as the web and the API: `src/tui/screens/issue.ts` and `pull.ts` comment and change state through `addCommentThrough` and `setIssueStateThrough` (`src/actions/issues.ts`), which call `providers.createComment` / `setState` when the repository is a mirror. The one-click sign-in has no terminal path (a forge has no device grant): Connected origins and Origin apps say so and point to the web page, and the terminal connects a forge with a token.

A forge's comments carry no edit time, so `updatedAt` is read when the forge sends one and is the creation time otherwise: an edited comment syncs once the forge reports edits. A thread is paged to its end; one of more than 100,000 comments is a failed sync, never a short one.

The preview of the pull was not exercised: the write-through is proven by `test/forge-origin.test.ts` (two forges in one process, including the origin going down and coming back), not by hand on the preview.

## What you can see there (#8900)

`/settings/origins/:id/repos` and `GET /api/v1/user/origins/:id/repos?group=yours|shared|public&q=&cursor=` show three groups, read live, searched and paged: repositories the account owns, ones it was let into, and what anyone may read on that forge. Owning nothing there is not an empty list. A forge is read by `GET /api/v1/repos` on every release, so "shared" means another account's private repository or anything in an organization the account belongs to; a public repository one person was given write on reads as public, since a forge's JSON carries no rights. Forgejo and Gitea use `/repos/search`. GitHub sorts the account's own list into yours and shared and has no public group.

Any of them can be mirrored here, and a mirror follows the one there. Sending work back from a repository someone else owns takes a token that can write there: `contribute` forks it there and opens a pull, and a read-only connection is refused in words. Test: `test/origin-repo-groups.test.ts`.

## The sync contract (`src/git/sync_link.ts`)

One contract written for every shape a network takes: a follower, a fork, a mirror, two forges syncing both ways, a forge with several upstreams, and a diamond. Today only one shape has a door: a fork following its parent on the same forge. Nothing yet calls it between two forges (no API, MCP, web or terminal door syncs a repository with one on another forge); the other shapes are exercised by tests alone. A link is judged (`judgeLink`: synced, behind, ahead or diverged, with the counts and the one action that reconciles it: fast-forward, offer, merge, or keep both) and synced (`syncLink`).

- **Idempotent.** A tip already held is a no-op, by whichever route it comes; a diamond lands once.
- **Resumable.** Their tip arrives by a fetch into a staging ref, which git writes whole or not at all, and our branch moves by compare-and-swap. A sync cut off at any point leaves the branch where it was; the next try finishes.
- **Divergence is never silent and never moved.** The branch stays; their tip is staged at the stage ref; both sides compute the same words and the same action.

**Where you meet it.** A fork's standing against its parent now names the one action that reconciles it (`none`, `fast-forward`, `offer`, `merge`, `keep-both`) and says it in words: in the `following` API read (`action`, `words`), on the fork's home card, in the terminal's forks screen (`Forks` → the follows row), and in MCP `following`. Taking the parent's work (`fastForwardFork`, which every push to the parent triggers) goes through `syncLink`, so it is compare-and-swap, stages the parent's tip at `refs/following/<branch>`, and refuses a divergence. `source` is always a repository path computed from rows, never text a person typed. Syncs into the same repository's stage ref take turns, so a push's follow-on and a person's click at once never race on that ref (test: "syncs at once into one stage ref take turns").

`test/sync-shapes.test.ts` walks each shape with real git between bare repositories on one machine. `scripts/forge-compat-lab/shapes.ts` holds the same shapes as lab cells between two real forges, but **they have not run yet**: they run only when asked for (`LAB_ONLY=shapes scripts/forge-compat-lab.sh`) and are not proven until a docker host has walked them. Not shown either: that a sync at one door reaches a web viewer live (the card reads the standing on each load; nothing pushes it). Not yet wired: the flows-view health of each link, the schedule probe, and the crew taking the action on autonomous repositories (the rest of #9451).

## A downstream forge as a peer (#9451)

A child forge's proposal (`child/<name>/…` head, proposal token) used to wait for a person to approve the exact head even when that forge was trusted. Now a writer trusts the pair *(forge, `child:<name>`)* in the same trusted-sources list as an origin's account, on the same page (`/settings/trusted`) and in the same terminal screen: write `child:kid` as the account. The forge is the host of the origin the proposal token was minted for; the name is the one the writer chose when minting it. Its pulls then run their checks and fold in like a trusted origin's (`foldsIn`, `src/core/trusted_sources.ts`).

**Why the two namespaces cannot cross.** Origin accounts are cleaned by `cleanAccount`, which refuses `:`, and `sourceOfUrl` and mirrored authors use it, so no origin account can ever be spelled `child:kid`. A child is looked up only as `child:<name>`. Trusting person `kid` on a host does not trust a child `kid` there, nor the reverse (test: "an origin account never trusts a child of the same name").

**Why the origin is not an unchecked claim.** Only a person who can write this repository mints a proposal token, and they type the origin and name; the pull's proposal row is written only by a request carrying that token (`proposal_gate`). A claimed host is therefore the writer's own statement, and nothing is trusted until a writer also trusts that exact pair. Nothing here verifies the forge answers at that host; trust is "work pushed with the token I gave that forge".

**Seeing why it ran.** The proposal line on a pull, in the web, terminal, API (`proposal.folds`) and MCP, says "trusted as child:<name> (trusted sources), so its checks run" when it does.

What still protects this forge:
- Trust is by date and ends on its own; a different name or a different forge is a stranger.
- The same stop switch (`stopFoldIn`) ends it at once, for origins and children alike.
- The same walls hold: `foldWall` still holds secrets, permissions and release machinery for a person, and `needsCrewReview` is unchanged (tests: "a trusted child's pull meets the same walls"). The token's gate still allows only reading, pushing under `child/<name>/` and opening a pull.
- An untrusted child's proposals still wait for a person to approve the exact head.

Tests: `test/trusted-downstream.test.ts`. The other limits of #9451 are separate issues linked to it.
