# A pull proposed to an origin, and its state coming back

On a repository mirrored from another forge, "Propose upstream" from a native
fork carries the branch to the origin and opens the pull there
(`actions/pulls.ts`, `origins/push-through.ts`), under the connecting account.

What the origin then says comes back two ways, through one path
(`origins/pull-check.ts`):

- **Webhook.** After the pull opens, a forge origin is asked once to deliver
  the mirror's events to `POST /api/v1/repos/:owner/:name/origin-hook`
  (`origins/hook.ts`; needs this forge's `url` to be https and a token with
  admin scope on the origin). The delivery is signed with a secret derived
  from the forge's key and the repository, so nothing is stored. It is
  believed for nothing but "look again": the named pull is re-read from the
  origin. Every refusal is the same 404.
  A delivery that names no pull is accepted and ignored, so one delivery costs
  one pull's re-read.
- **Poll.** Each sync sweep re-reads at most 20 open pulls: those whose check
  is not settled (never read, running, not run, or for an older head), and
  any settled one not read for an hour, least recently read first. So a
  delivery that never came, or an origin that was down, is caught up on the
  next sweep, and a sweep costs a bounded number of origin requests.

Asking the origin for the hook happens after the pull opens and off the
request path (10 s at most); the person has their pull first.

The pull page, and the pull screen in the terminal (the merge box), show the
origin's check ("Check on bob/app: passing, as of …") and import its reviews. An origin that does not answer leaves the last word
standing. A forge origin gives its own `check` word; a Gitea or Forgejo origin
gives its combined commit status; GitHub's checks are not read yet.

The signed webhook path is tested by a hand-posted, correctly signed request
(`test/origin-pull-state.test.ts`); no real origin has delivered to it yet.
The terminal line is tested in `test/tui-pull-origin-check.test.ts`.
