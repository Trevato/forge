# Sending your forge's idea upstream, and pulling back

Two directions, three steps each. A pull from a fork someone keeps lands here as a true merge commit (#8935): your commits stay ancestors of main and keep your name, so pulling back never conflicts with your own code. Crew pulls and pulls made inside one repository still squash.

## Send an idea upstream

1. **Fork** the app (or connect its forge at `/settings/origins`) and push your work to a branch of your fork.
2. **Open a pull** from that branch against the upstream's `main` (`Contribute`, or `POST /api/v1/repos/:owner/:name/pulls` with `headRepo`).
3. **Wait for a person to land it.** They choose nothing: a kept fork always lands as a merge, whatever strategy is asked. You get a thank-you note on the pull saying how many commits, by whom, touching how many files.

## Pull back what landed

1. **Fetch** the upstream's `main` into your fork (`git fetch <upstream> main`).
2. **Merge** it (`git merge FETCH_HEAD`). Your landed commits are already ancestors of it, so it is clean or a fast-forward; only work that landed from others can need a hand.
3. **Push** to your fork. Your next pull upstream carries only what is new.

Test: `test/kept-fork-landing.test.ts` runs two clones of two repositories through both directions.

## Every door says so

The rule lives in `landingKind` (`src/core/landing_kind.ts`) and `mergePull` applies it, so the API, the MCP `merge` tool and both screens land a kept fork as a merge. The choice is not offered where it would be ignored: the web merge box shows "Lands as a merge commit" in place of the strategy menu, and the terminal's merge confirm (`m` on a pull) drops Squash and says the same. A pull by or from an agent, or inside one repository, keeps both choices.

## Combined on our side

When main has moved since a kept fork's head, the forge merges main into that head in a branch of the base repository, `combined/N` (`src/git/combined.ts`), on opening the pull, on every push to the fork, and again just before landing. The author's branch is never written. Each conflicting block keeps main's side, with no review: the author's side of that block is dropped from the landed tree, and the note says so and how to get it back (merge main into their branch, resolve, push: a head that already has main is its own combined build). A conflict git cannot pick a side of (modify/delete, rename) is left open. The combined commit's message is the note, and its `Combined-Base` and `Combined-Kept` trailers are the facts the pull renders from (`src/core/combined_view.ts`): a "Combined with main" card on the page and the same section on the terminal's pull screen. The preview builds `combined/N`, under the approval of the head it carries (read from git, `headUnder`), and landing merges it, so the author's head stays an ancestor of main. Commits pushed on top of `combined/N` by a writer are kept by the next combining.

A push to main alone does not recombine: the card marks itself stale, naming the main commit it was built on, until the next push to the fork or the landing recombines. Checks run on the pull's head, not on the combined commit, and the card says that too.

Test: `test/combined-fork.test.ts` (open, page, terminal, a push recombining, stale, landing) and `test/combined-git.test.ts` (a writer's commit surviving, modify/delete left open, the head a preview runs under).

## Not yet

Landing a very large fork in reviewed slices that still end as a merge of the author's head; routing a pull opened on the Forgejo mirror to trunk; a crew run sent to refine `combined/N` beyond main's side; recombining when main alone moves; running the check on the combined commit; and running his code under the guest rule until a person approves (#8903 is not in this repository). Resolving conflicts on our side is today's resolve page (`docs/PULLS.md`).
