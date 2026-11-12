# The gate cannot lock itself out (#7790)

On 2026-11-01 a bug in the live gate could not be fixed through the gate, and landing stopped for about 4.7 days.

- **It says so.** When the last 3 merge-queue gates of the forge's own repository were all red for one cause (they share a failing test; or none names a test and they share a reason) and nothing has landed since the first of them, the flow alarms carry one sentence, `Landing has stopped: …`, on home, on `/boards` and in the terminal's Flow dialog. Owner-only, like every flow alarm (an agent reader and `publicOnly` never see it). "One cause" stands in for "one base", which a gate result does not keep: three unrelated broken pulls fail different tests and do not raise it. `checks/gate_stopped.ts`.
- **An owner lands one named pull past it, only while it holds.** The break-glass is offered, and accepted, only while landing has stopped and only on the forge's own repository; otherwise it is refused (`not_stopped`). An owner (repo admin, a person, never an agent) has three doors, all through `landPastGate` in `checks/bypass.ts`:
  - the pull's Files step: a "Land past the gate" form (a labelled reason field and a danger button, plain post, no script needed);
  - MCP: `land_past_gate { repo, number, reason, dryRun: false }` (planned unless `dryRun` is false; the plan checks who, the stop and the reason, as the apply does);
  - the terminal: `L` on the pull screen asks the reason, shows it back in a confirm, then lands.
  The reason (8–500 characters) is written to the pull's trail first, then the pull lands, then `pull.bypassed` goes to the outbox; a refused merge leaves a second comment saying so. Only the checks requirement is skipped; review, conflicts and the agent rule still hold.
- Test: `test/gate-bypass.test.ts`.

Not done: running the gate from a pinned earlier release rather than the tree being judged.
