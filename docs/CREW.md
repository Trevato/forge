# The sentinel

The forge hunts its own faults (`src/crew/sentinel.ts`, #1131). It reads what
the forge already holds and files what is wrong, with the evidence quoted.

**When.** On the autonomy clock: a hunt an hour, and one sooner (never within
ten minutes of the last) when a signal is new — queued checks waiting while no
run uses a slot, or a capacity setting away from its default for over a day.

**What it reads.**

| Fault | Read from |
| --- | --- |
| a slot held by a finished run | `run`: queued work older than 30 min, nothing running or every lease lapsed |
| a check never green; pushes that cannot land | the last 20 `check` / `agent` run summaries per repository |
| `retry` stops, guard parks | the decision ledger (`decisionsSince`) |
| a setting left away from default | `forge_setting` against `capacityDefault` |
| a hand-installed trigger | `sqlite_master` against a scratch database migrated from the schema |
| the same ERROR line again and again | the error ring (`kernel/log.ts`) |

**What it files.** One issue per finding, titled `Sentinel: …`, with the
evidence, the pillar, and *what to look for when fixed*. `sentinel_finding`
remembers the key and the issue: a finding still open is a comment on its
issue, and only when its evidence changed; one whose issue was closed and
returned is filed again. It files in `FORGE_SENTINEL_REPO` (default
`trevato/forge`) as the `sentinel` agent, else the first admin.

**What it shows.** To a site admin only: the board's forge strip and the
terminal palette's `Sentinel` command show the count of open findings and the
last hunt's time. A hunt is synchronous, so there is no "hunting" state to show.

**What it never quotes.** Evidence passes through `scrub` (`redactSecrets` and
any 32-character unbroken token) before it is filed, since the repository may
be public.

**Not done.** Ingress routes and other edge objects are not in this database,
so the sentinel cannot see them. It does not open fix pulls: a finding with a
mechanical fix says what it is, and a crew run takes the issue up. Direction at
its cap and WARN lines are not read yet.
