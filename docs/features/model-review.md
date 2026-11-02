# The weekly model review

Once a week (`runModelReview`, ticked hourly from `src/main.ts`, runs at most once in seven days) the forge reads its ledger and, per crew member, compares the models it ran on over the last 28 days: cost per landed pull (every agent run on a pull counts), red first-check rate, change-request rounds per landed pull, reverts, and how hard the work was (share of pulls that escalated by need: `p0`, `label:opus`). The figures are on Settings → Crew ("Model review"), in `GET /api/v1/crew/scorecard` and the `scorecard` MCP tool (`modelReview`).

- **Plain code** (`src/core/model_review.ts`): the ladder is fable → opus → sonnet → haiku. A model with reverts, a rework round per landed pull, or half its checks red is asked a step *up*. A healthy one is proposed a step *down*, unless over half its work was hard, or the cheaper model has its own numbers and they are no better.
- **At most one change per agent per week** (a change just settled counts), and none while one waits for a person or for its result. A change, its trail row and its event are written in one transaction.
- **Small samples change nothing**: under `model_review.min_landed` landed pulls (default 8) the page says so.
- **Applies itself or asks**: a step down applies on its own when the owner sets the limit `model_review.auto` to 1 (default 0); a step up always asks. Asking is one button on the page ("Move to …" / "Leave it") and, in the terminal's "Crew scorecard per agent", `m` / `n` on a `waiting` row, then `y` (both call `decideChange`, a forge admin's only). An ask nobody answers lapses after two weeks as declined, and frees the agent.
- **On the trail**: `crew.model_asked`, `crew.model_changed` (with the before numbers), `crew.model_declined`, `crew.model_result`.
- **A week after** a change (kept waiting up to two weeks for enough landed pulls) the result is reported; the change is undone when reverts rose, the red rate rose by more than `model_review.slack_pct` points (default 10), or rework rose by more than half a round. A model changed by hand meanwhile is left alone.

Not done: an MCP tool for the button (the decision is on the page and in the terminal), and the review does not look at an agent running on the runner's default model.
