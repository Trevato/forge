# How a fork follows its upstream

A fork follows its upstream in one of three modes, said in one line on its page:

- **Follows ann/yard automatically** (`take-updates`): new code is merged as it lands; a conflict goes to the crew.
- **Takes updates from ann/yard** (`take-updates`, the default for a new forge): a fork with no commits of its own fast-forwards by itself; one with commits of its own gets a pull to merge. A plain fork defaults to `tell-me`: its owner is told and chooses.
- **Does not follow ann/yard** (`dont-follow`, #608): nothing is fast-forwarded, merged or announced, and the crew is never asked to converge. The fork can still offer its changes up.

The line shows only on a fork, to anyone who can see the page.

## Where

The fork's repository page and its forks page (`/:owner/:name/forks`) carry the same Following card. On the forks page the card shows only to the fork's admin, above the family tree. The tree runs from the oldest ancestor the viewer may read, with each fork's ahead and behind counts against its own parent. When the fork is ahead, the card's **Offer this change** opens one pull on the parent (`proposeUpstream`).

## Switching

- **Web:** an admin of the fork sees a button for each of the other two modes beside the line. Each opens a confirm that says what changes ("without asking", "nothing is merged until you take it", "the crew is never asked to converge"). The POST is same-origin only, and the change is recorded as a `forge.follow_mode` event with the repository and the person.
- **MCP:** `follow_mode` with `repo` and `mode` (`take-updates`, `tell-me` or `dont-follow`) switches it for an admin and answers in the same words as the page. Anyone else is refused. `following` returns the current `mode`, and `fork_tree` names each node's `follow`.
- **Terminal:** on a fork's screen the row shows the same line; `m` steps to the next mode and the toast says the same sentence.

A spawned forge's chain (its code repository following its parent forge) takes only `tell-me` or `take-updates`. To follow nothing, it severs.

## What honours it

`follow` in `src/core/following.ts` skips a `dont-follow` fork when its parent's default branch moves, and `followDivergence` in `src/crew/converge.ts` never converges one.

The words live in `src/actions/follow_words.ts` and `followModeSaid` in `src/actions/follow.ts`; every door reads them from there.
