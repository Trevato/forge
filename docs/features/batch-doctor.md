# Batch doctor (#7555)

When the merge queue's re-gate hands a pull back red (the re-gate carries it alone, so a red on top of other pulls is the queue's own search, #4999), `src/checks/doctor.ts` classes the red (`doctor_classify.ts`) and acts, in `crew/autonomy.ts`'s `handBack`:

- **functional, alone on its merge**: the pull is held "until green" (out of the line), commented with the test, file, error line and `bun test ./file` to reproduce, and assigned back to its builder. A new head that passes its own check lifts the hold (`releaseOnGreen`). A red is held only when it reproduces on the queue's re-gate (the same head and base red again), so a flaky red still lands (#3155). A hold already on the pull (a person's) is kept, never overwritten.
- **budget / infra**: recorded as `recheck`, not held. the queue re-gates a red pull alone later (#3155).

Every act is a `maintenance_run` row (`duty = batch-doctor`): batch (`base:head`), culprit pull, class, action, probe (the first error line); the newest 200 per repository are kept (`RUNS_KEPT`). A sealed pull's number, batch and probe are told by no door. Read them on the flow panel (Batch doctor card), in the terminal Flow dialog, or as `doctor` in MCP `queue_gates` (all `doctorRuns`). A doctor's hold reason begins `batch doctor:` (`HOLD_PREFIX`, `isDoctorHold`). The infra class matches errno codes, `no space left`, `disk quota` and `tar:` lines only.
