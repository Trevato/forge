# Economics: the profit slider, its prices and what the month costs

One number per forge, `position`, a whole number from 0 to 100, and beside
it the margin on crew spend, `marginPct`, a whole number from 0 to 500. The
design is `docs/PROFIT.md`; this is the first step (#504): the numbers are
stored and the policy they mean is shown, but nothing acts on them yet.

- **Settings → Economics** (`/settings/economics`, a forge admin who is a
  person): a range input for the position, a number input for the margin,
  and the policy in words, e.g. at 50 "production sleeps after 24 h idle ·
  previews after 30 min · cloud takes work above 85% of owned capacity · a
  quiet pull's preview stops after 3 days". Every change is listed below.
- **Terminal** (the forge's ssh terminal, palette → **Economics**, the same
  admin who is a person): the policy in words as the head line, the
  position and the margin as rows; `e` asks for a whole number, shows
  from → to, and changes it only after a confirm.
- **API**: `GET /api/v1/forge/economics` (read scope) answers
  `{ position, marginPct, policy, words, changes }`; `PUT` with
  `{"position": 70}` and/or `{"marginPct": 15}` (admin scope) sets them. A
  field left out keeps its value; anything but a whole number in range is a
  422 (`bad_position`, `bad_margin`) and changes nothing.

`policy` is `policyAt(position)` (`src/core/slider.ts`): milliseconds for
`sleepAfterMs.production`, `sleepAfterMs.preview` and `idlePullMs` (`null`
is never), and `spillAtOwnedUse`, the share of owned capacity (0–1) above
which cloud takes work. It is linear between the rows at 0, 50 and 100;
above 50 "never" counts as a 7-day cap until 100 itself. 50 is the
runtime's constants (`SLEEP_AFTER_MS`, `IDLE_PULL_DAYS` in
`src/apps/runtime.ts`), so a forge that never moves the slider behaves as
before.

- **MCP**: the `economics` tool answers the same as `GET`; with `position`
  and/or `marginPct` an admin token plans the change (`dryRun` is true unless
  `false`) and then sets it, through the same action and validation.
  Anyone else is told `not_found`, as the API does.

An agent can never move the slider, whatever it was granted.

## Prices and what the month costs (#507)

The operator sets four prices beside the slider. They are stored as whole
cents, and every change is kept in the same history as the position.

| field               | unit                                      | range              |
| ------------------- | ----------------------------------------- | ------------------ |
| `ownedMonthUsd`     | US dollars per calendar month, owned box  | 0–1,000,000.00     |
| `ownedSlots`        | app-slots the owned box holds (a count)   | 0–10,000           |
| `cloudHourUsd`      | US dollars per awake-hour on cloud        | 0–1,000,000.00     |
| `storageGbMonthUsd` | US dollars per GB-month kept (decimal GB) | 0–1,000,000.00     |

Prices take at most two decimals and cannot be negative. Anything else is
refused as `bad_price` (or `bad_slots`) and nothing changes.

- **Settings → Economics**: the Prices form, then **This month so far**,
  with the owned, cloud, storage, crew and total lines in US dollars for the
  UTC calendar month up to now. When the box and its slots are both set,
  the page also shows the box's price per app-slot.
- **Terminal**: the four prices are rows beside the position and the
  margin. `e` asks for the value in dollars, shows from → to, and changes
  it after a confirm. The bottom line shows this month's cost.
- **API**: `GET` adds `prices` (dollars) and `month: { from, to, cost }`;
  `PUT` takes any of the four fields, e.g. `{"ownedMonthUsd": 300,
  "cloudHourUsd": 0.05}`.
- **MCP**: `economics` takes the same four fields, planned first as for the
  position.

The cost is `costOf` in `src/core/cost.ts`, a pure function. Each line is
in US dollars:

- **owned** = box $/month × the share of each UTC calendar month the range
  covers. It is a fixed cost: a whole month, of 28 or 31 days, is exactly
  one box, whatever ran.
- **cloud** = cloud awake-seconds ÷ 3600 × $/awake-hour.
- **storage** = GB-hours ÷ 730 × $/GB-month. A month is 730 h (8760 h ÷
  12), the usual cloud-billing month.
- **crew** = the usage ledger's `costUsd` (list price).
- **total** = the four lines summed.

Everything is summed in unrounded cents. Each line and the total are
rounded once, at the end, to the cent; the total is the unrounded sum,
rounded. Worked example: a $300 box + 40 h of cloud at $0.05 + 12
GB-months at $0.02 + $57.10 of crew = $359.34.

## Placement (#509)

Where an environment runs is decided by `placeFor`
(`src/core/placement_policy.ts`), a pure function of how full owned metal
is, the slider's `spillAtOwnedUse`, whether the environment is production
or `always_on`, the app's `placement: metal|cloud` preference and whether a
cloud body is configured:

- owned metal first; a preview spills to cloud once owned use reaches the
  threshold, production and `always_on` apps only when owned is full;
- `placement: cloud` is honoured; `placement: metal` is honoured unless
  owned is full;
- with no cloud body configured (`CLOUD_BODY_CONFIGURED` in
  `src/spawn/placement.ts`, false until a cloud body exists — spike #339)
  every answer is `owned` and its reason says "no cloud body: bursts queue".

The runtime asks as each meter interval opens: the answer is the interval's
`placement` (so cost knows which price applies) and a `place` row in the
decision ledger (`recordPlacement`, `src/core/decisions.ts`) with the
inputs, the one-sentence reason and the body target. `place` rows are
counted, not listed among the crew's decisions on the board; the API's
decisions list returns them with `kind=place`.

The label that selects owned nodes, `ownedNodeLabel` (default
`plat.sh/site=vxrail`), is a setting, at every door: a field on Settings →
Economics, the third row of the terminal's Economics screen (`e`, then a
confirm), `PUT /api/v1/forge/economics` and the MCP `economics` tool
(planned first, like the numbers) take `ownedNodeLabel: "key=value"`.
Blank is the default again; anything else is refused (`bad_label`). `GET`
and the tool answer `placement: { cloudBody, ownedNodeLabel, words }`; an
owned decision passes the label to the body as its `nodeLabel`.

Where a burst would wait is said, never silently: the site admin's strip on
the board reads "All fine · Placement: no cloud body: bursts queue" (or
carries that line among its notes), as do Settings → Economics and the
terminal screen's second line.
