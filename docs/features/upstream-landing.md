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

## Not yet

Landing a very large fork in reviewed slices that still end as a merge of the author's head; routing a pull opened on the Forgejo mirror to trunk; a preview of the combined build with a crew-written resolution note; and running his code under the guest rule until a person approves (#8903 is not in this repository). Resolving conflicts on our side is today's resolve page (`docs/PULLS.md`).
