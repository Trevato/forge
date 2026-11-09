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

An agent can never move the slider, whatever it was granted.
