# Hunters (#5846)

`bun scripts/hunt.ts <origin>` runs the detector sets in `src/hunt/` against one app and prints findings as JSON (exit 1 when there are any). It is GET-only by construction (`probe.ts` has no other method), same-origin only, and ends after one pass.

| Lane | Module | Detectors |
|---|---|---|
| Front door | `door.ts` | personal pages send anonymous visitors to sign-in with `next=`; public pages answer 200; unknown path is 404 |
| UI (links) | `links.ts` | every link on the top pages: no 404/5xx, and a link landing on `/` must be labelled Home (#5844) |
| Contract | `contract.ts` | no OpenAPI GET route answers 5xx; the status is documented or a refusal |

A finding's `key` is stable (`detector:subject`): one issue per key, a comment only when the evidence changes.

Not built yet: headless-browser lane (buttons, console errors, fold, overflow), flows, speed, the schedule (post-release and 08:00Z), filing issues, the KPI card on home, and the weekly retro.
