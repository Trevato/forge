# The profit slider — cost against responsiveness

Design for issue #392, the twin of the subscription governor (#341): the
governor decides how much work runs now; the slider decides where it runs,
how long it stays awake, and what it is charged. Each forge has one slider.
It's built as linked issues; this page describes the design they share.

The owner wants owned metal to run at full capacity, because it is paid for
either way. Cloud takes the bursts. A forge charges for awake time, storage
and crew spend, with a margin on the crew spend.

## The control

`position` is an integer from 0 to 100, set once for the whole forge:

- 0 is the cheapest setting: apps sleep early and nothing spills to cloud
  until owned metal is full.
- 100 is the most responsive: apps stay warm and work spills to cloud early.

`policyAt(position)` is a pure function that interpolates linearly between
three anchor rows. Position 50 is today's behaviour exactly, so landing the
slider changes nothing until someone moves it.

| position | production sleeps after | preview sleeps after | idle pull stops after | cloud takes work above owned use |
| -------- | ----------------------- | -------------------- | --------------------- | -------------------------------- |
| 0        | 10 min                  | 5 min                | 1 day                 | 100% (only when full)            |
| 50       | 24 h                    | 30 min               | 3 days                | 85%                              |
| 100      | never                   | 24 h                 | never                 | 60%                              |

The 50 row is the constants in `src/apps/runtime.ts` (`SLEEP_AFTER_MS`) and
`FORGE_PREVIEW_IDLE_DAYS` in `src/main.ts`. "Never" counts as infinity in the
interpolation, so any position above 50 interpolates toward a cap of 7 days
instead. An app's `always_on: true` is the only override an app can set.

The margin is a separate number that sits next to the slider and does not
move with it. The margin sets price; the slider sets cost and
responsiveness. The board's gap line shows whether the two together leave a
profit.

## Units and formulas

All money is in US dollars. Crew spend uses the list-price figure the usage
ledger already records (`src/core/usage.ts`).

- cost = owned box $/month, a fixed cost spread over the month
  + cloud awake-hours × cloud $/hour
  + GB-months × storage $/GB-month
  + crew `costUsd`
- revenue = awake-hours × awake price
  + GB-months × storage price
  + crew `costUsd` × (1 + margin%)
- gap = revenue − cost

`src/core/cost.ts` (`costOf`) is the cost half. Owned metal is spread over
each UTC calendar month, so a whole month (28 or 31 days) costs exactly one
box, and a range pays each month's elapsed share. Storage turns GB-hours into
GB-months at 730 h (8760 h / 12, the cloud-billing convention). Prices are
kept as whole cents and set in Settings → Economics or through
`PUT /api/v1/forge/economics` (`ownedMonthUsd`, `ownedSlots`,
`cloudHourUsd`, `storageGbMonthUsd`). Each line and the total are rounded once,
at the end, to the cent; the total is the unrounded sum, rounded.

Rounding happens once, at the end, to the cent. Worked example: a $300 box,
40 h of cloud at $0.05, 12 GB-months at $0.02 and $57.10 of crew spend
cost $359.34.

`src/core/revenue.ts` (`statementFor`) is the revenue half, one app and one
UTC calendar month at a time: lines `{ what, quantity, unit, price, amount }`
for awake time (every environment, owned or cloud), storage, crew spend at
cost, and the margin on crew spend — the margin touches crew spend only.
List prices are whole cents beside the costs (`awakePriceHourUsd`,
`storagePriceGbMonthUsd` in Settings → Economics and the economics API).
Amounts and the total are rounded once, at the end, as for cost. Worked
example: 100 awake-hours at $0.10, 3 GB-months at $0.25 and $57.10 of crew
at a 20% margin charge 10.00 + 0.75 + 57.10 + 11.42 = $79.27; at margin 0,
$67.85. Read it at `GET /api/v1/repos/:owner/:name/statement?month=YYYY-MM`
(JSON, or `format=csv`) or print it from the app's settings
(`/:owner/:name/settings/app/statement`); see `docs/features/statement.md`.

`src/actions/money.ts` is the gap (#510): revenue is the sum of the apps'
statements — both start from `monthUse` and `chargeOf`, so there is no second
sum — and cost is `costOf` over the month so far. A day's cost is `costOf`
over that day, and its revenue the sum of each app's `chargeOf`, rounded to
the cent per app; one meter pass (`usageBins`) and one ledger read
(`usageDays`) give all thirty days. One app's cost carries the owned box in
proportion to its share of the forge's owned awake time this month, so the
forge's cost is the apps' costs plus the box's unowned share. How to read it: `docs/features/money.md`.

## The order (what waits for what)

| issue | what                                                         | waits for  |
| ----- | ------------------------------------------------------------ | ---------- |
| #504  | the position, `policyAt`, Settings → Economics, the API      | —          |
| #505  | meter awake intervals and storage per app and environment    | —          |
| #506  | sleep windows follow the slider, live                         | #504       |
| #507  | cost model: owned amortised, cloud hourly, storage, crew      | #504, #505 |
| #508  | revenue statement with the margin, JSON/CSV/print             | #507       |
| #509  | placement policy: owned first, bursts spill                   | #504, #505 |
| #510  | the board: cost, revenue and the gap, with a 30-day SVG       | #507, #508 |
| #511  | MCP `economics` read and its API twin                         | #510       |

#391 (the `services` app kind) waits for #509.

## Choices

- The slider is one control per forge, not one per app. The only per-app
  exception is `always_on`, and a `placement: metal|cloud` preference that
  the policy honours unless owned capacity is full.
- Placement is decided here; where an app actually runs is up to the spawn
  seam's body (`src/spawn/placement.ts`, spike #339). If no cloud body is
  configured, the decision is always `owned`, and the board says that bursts
  queue.
- The owned-node label (`plat.sh/site=vxrail` today) is a setting, not a
  constant.
- Billing produces a statement, with no payment processor. A person can
  check every line by hand.
