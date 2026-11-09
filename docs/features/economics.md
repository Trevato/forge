# Economics: the profit slider's position

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
