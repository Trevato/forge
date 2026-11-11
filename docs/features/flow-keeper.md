# Flow keeper (#7556)

A maintenance duty, `flow-keeper` (`src/maintain/duties/flow_keeper.ts`), runs once a minute and leaves a `maintenance_run` row (see `/maintenance`) with its findings, each with its probe, and what it did. It reads the database and spends no model tokens.

| Part | Module (`src/maintain/keeper/`) | What it does |
| --- | --- | --- |
| Stuck | `stuck.ts` | Finding: an approved, open, unheld pull with no run, review or push for 30 min that is not landable (conflicted, red, unchecked). Green on its head is queue wait. |
| Conflicted, rebase loops | `rebase.ts` | Assigns a conflicted approved pull to the builder who can push its branch (`ownBuilder`, #7006), at most 6 per run. After 2 assignments with no new head it stops and says so once on the pull. A person's assignee or hold is never moved. |
| Wrongly held | `holds.ts` | Lifts a crew hold when a check went green on the head after it, or it is over 6 h old. A person's hold is never read. |
| Lulls | `lull.ts` | Builders idle while startable issues exist, or checks idle while pulls wait, two samples in a row: one `keeper_lull` start event with the cause (`crew/idle_reason.ts` words: ceiling reached, no subscription with headroom, hot file), one end event. Nothing while nothing is startable. |
| Forge down | `down.ts` | Health failing twice from two vantage points: a `forge_down` event, then `forge_up`. Alarm only; the release keeper owns rollback. Vantages: `FORGE_HEALTH_VANTAGES=home=https://…/healthz,far=https://…/healthz`; with fewer than two, nothing is sampled. |
| Closed, handed off | `handed.ts` | An in-repo crew pull closed with no reason, or assigned to a person, is reported once, as a comment on the pull. |
| Alarms | `words.ts` | Each firing flow alarm gets a finding and an action line saying what the keeper did (or that it only reports). |

Conflicted pulls are the ones the crew's runs and the finishing pass already mark (`flow/conflicted.ts`); the keeper does not ask git. Comments the keeper writes are posted under the name of whoever turned autonomy on, with a line saying so, as the finishing pass's hand-over does (`crew/finishing.ts`): the repository has no steward identity of its own to post as, and the line on each comment says the forge wrote it.

Terminal door: the keeper's acts (`keeper_rebase`, `keeper_release`, `keeper_lull`, `forge_down`/`forge_up`) are also the `actions` of each `flow-keeper` row, and the terminal already lists those rows (the maintenance runs screen, `src/tui/screens/maintainruns.ts`, and `/maintenance`), so it has no screen of its own. The raw events are admin-only (`event_audience.ts`).

Tests: `test/keeper-stuck.test.ts`, `keeper-rebase-loop`, `keeper-holds`, `keeper-lull`, `keeper-down-two-vantages`, `keeper-handed` (handed-off pulls, alarm words, forge_down through the default runner).
