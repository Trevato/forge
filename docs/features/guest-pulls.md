# Guest pulls

A pull whose author lives on another forge — brought in from the origin, or
whose head lives in a fork there — is a **guest** (`src/origins/guest.ts`).

Until a person who can write the repository approves it once:

- its preview starts with none of the app's variables and no forge token
  (`AppsRuntime.secretsFor` in `src/apps/runtime.ts`);
- the crew does not send it to review (`src/crew/review.ts`).

Its check needs nothing here: a check never carries the repository's
secrets, a guest's or anyone's (`src/checks/service.ts` builds its
environment from the forge's own names only).

The pull page says it is a guest to everyone; writers see **Approve this
guest**, a same-origin form posting to `/:owner/:name/pulls/:number/approve-guest`.
In the terminal the pull screen says the same, and a writer presses `G`.
Both call `approveGuestPull` (`src/actions/pulls.ts`), which announces
`pull.guest_approved`: open pages hear it live, and the preview starts again
holding the app's variables.

**The approval is per pull, not per head.** It is kept in `guest_approval`
and stays when the guest pushes again: every later head of that pull runs
with the app's variables too. What still asks per head is whether the code
may run here at all (`src/core/pull_trust.ts`, "Approve to run here"), so a
new head from a fork on the origin waits for that approval before anything
runs. Approve a guest when you trust its author with the preview's
variables, not only its current diff.
