# Reviews are something an owner turns on (#11666)

A green pull in an app whose owner has **not** asked for reviews, and where no reviewer is seated, lands by itself. No review is sent and nothing waits for one.

**This changes the default.** Before, a green agent pull with no reviewer seated waited for a person forever. Now, with **Require review** off (the default) and no reviewer on the crew, it lands once its check passes. A new forge's first app has reviews off, so its first change goes live on green. An owner who wants a second look before anything lands turns reviews on, as below.

## How to turn reviews on

Either one keeps every agent pull waiting for an approving review:

- In the app's settings, turn on **Require review**. Agent pulls then wait for an approving review, from a person or a seated reviewer.
- Or seat a reviewer on the crew. Reviews stay on wherever a reviewer is seated, whatever the setting says.

## What still stops a pull with reviews off

A conflict, a red check, a hold, the access wall, and a `changes requested` verdict on the head. Only the wait for a review is gone. The pull's page, the terminal and the MCP `pull` tool read "Next: queue, green, reviews are off: it lands".

## One rule

`reviewsOff` in `src/crew/review.ts`: `requireReview` is off **and** no reviewer is seated. The gate (`reviewed`), the review waits (`reviewWaitsFor`) and the next-actor line (`nextAsking`, used by `nextOfPull` and `stepsOfStored`) all ask it, so they cannot drift.

## Cost

The seated reviewers are read only when the answer would otherwise be "waiting for the reviewer", and only when **Require review** is off: at most once per pull page, at most once per batch of pulls. The pull page loads no crew otherwise, so its budget in `test/pages-budget.test.ts` is one higher for that read; the batch's is unchanged.
