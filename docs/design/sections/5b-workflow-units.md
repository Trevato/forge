### 5b. The workflow units

A unit is a whole intention with one button behind it, not a sequence of
screens you assemble yourself. Five of them, and the web renders each as one
form:

**Fork** — on a live browse and on every picker row you cannot push to. It
POSTs `…/fork`, forks at the origin, and answers with the mirror job page,
exactly as Mirror does, because the local copy of a fork is a job with stages.
The flash names both halves and the host: `Forked octo/widgets to me/widgets at
codeberg.org.` Not offered on a repository the connected account already owns —
neither forge forks you to yourself. A native repo keeps its own `…/fork`.

**Propose a change** — where the origin says you may not push, Edit and New
file become Propose a change and open the ordinary editor with the propose card
under it. One POST to `…/contribute` forks if needed, branches on the fork,
commits, and opens the pull upstream with the `owner:branch` head form. You land
on the pull: its page here if we mirror the upstream, its live-browse page if we
do not — never thrown out to another forge mid-workflow. Every refusal
re-renders the editor with the text still in the textarea (`§6c`'s rule: never
lose a keystroke).

**Pass a verdict** — the review card, one POST to `…/review-state`. Verdicts
land in the timeline as `verdictBadge` items in time order with the comments and
the state changes, because a verdict is a thing that happened at a time.

**Settle a thread** — every review comment sharing an anchor is one
conversation, resolved by a writer or by anybody in it, at
`…/threads/:anchor/{resolve,unresolve}`. The files header counts them:
`3 threads · 1 unresolved`.

**Merge, or not** — the merge box gains a sixth state, _Waiting on review_,
whenever `require_review` is unsatisfied or a change is outstanding. The button
is disabled and the chip says who to talk to; the refusal is `mergePull`'s
(`review_required`), and the disabled button is only the honest preview of it.
`Require an approving review before merging` is a checkbox in General settings.

One rule holds all five: **the page never decides.** Every affordance here is
rendered from the same answer the action will give — `permissions.push` for
propose, `status.reviews` for the gate, `canWrite` plus thread authorship for
resolve — so a button that is absent and a call that is refused are the same
fact said twice, and never two different facts.
