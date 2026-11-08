# Escalate to Opus by need

A run picks its model from the work, not only the agent (`src/crew/model_choice.ts`):

- an issue serving the P0 pillar, or labelled `opus` → `opus`
- a planner's run → `opus`
- the next round on a pull that has two or more changes-requested reviews → `opus` (not for the reviewer's own run)
- anything else → the agent's own model

The run row records `model` and `model_reason` (`agent`, `p0`, `label:opus`, `planner`, `bounced:N`).
Settings → Crew (`/settings/crew`, "Per model per day"), the terminal's "Crew scorecard" list (admin only) and `GET /api/v1/crew/scorecard` (`modelDays`) show runs, spend and landed pulls per model per day.
