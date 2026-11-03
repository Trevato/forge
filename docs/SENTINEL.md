# The sentinel

The forge hunts its own faults (`src/crew/sentinel.ts`, #1131). It reads what
the forge already holds and files what is wrong, with the evidence quoted.

**When.** On the autonomy clock: a hunt an hour, and one sooner (never within
ten minutes of the last) when a signal is new — queued checks waiting while no
run uses a slot. A capacity setting away from its default is no signal and
no finding: it is a line on `/settings/capacity` (#3269).

**What it reads.**

| Fault | Read from |
| --- | --- |
| a slot held by a finished run | `run`: queued work older than 30 min, nothing running or every lease lapsed |
| a check never green; pushes that cannot land | the last 20 `check` / `agent` run summaries per repository |
| `retry` stops, guard parks | the decision ledger (`decisionsSince`) |
| a hand-installed trigger | `sqlite_master` against a scratch database migrated from the schema |
| the same ERROR line again and again | the error ring (`kernel/log.ts`) |

**What it files.** One issue per finding, titled `Sentinel: …`, with the
evidence, the pillar, and *what to look for when fixed*. `sentinel_finding`
remembers the key and the issue: a finding still open is a comment on its
issue, and only when its evidence changed; one whose issue was closed and
returned is filed again. It files in `FORGE_SENTINEL_REPO` (default
`trevato/forge`) as the `sentinel` agent, else the first admin.

**How it is labelled** (#8856). Each finding declares a kind, and is filed
with its labels, so the bug clock (`src/flow/bugs.ts`) runs from the filing
and nobody has to sort it:

| Kind | Labels | Clock |
| --- | --- | --- |
| `security` (a hand-installed trigger; a personal page not sent to sign-in) | `bug`, `high` | 4 h |
| `broken-route` (a public page, link or documented route that answers 404 or 5xx) | `bug`, `high` | 4 h |
| `defect` (every other finding, and the performance watcher's slow routes) | `bug` | 48 h |
| `cosmetic` (a link that lands on `/` and is not Home) | `polish` | none |

A label the repository lacks is made (`src/hunt/label.ts`, shared by the
sentinel and `src/perf/duty.ts`); labels already on the issue stay, and an
issue adopted after its record was lost is labelled again. A budget breach
also gets `P0 Trust`. Every detector declares its kind, and the type check
refuses one that does not (#8969): a sentinel `Finding` requires `kind`, and
the route hunters (`src/hunt/door.ts`, `links.ts`, `contract.ts`) and the
performance watcher name their detector in `DETECTOR_KINDS`
(`src/hunt/finding.ts`), which `found` reads the kind from.

**What it shows.** To a site admin only: the board's forge strip and the
terminal palette's `Sentinel` command (as a toast) show the count of open findings and the
last hunt's time. A hunt is synchronous, so there is no "hunting" state to show.

A check that has never been green is filed only for the sentinel's own repository. In any other repository it stays on that repository's checks and the degraded list.

A capacity setting away from its default is not a finding: the sentinel files
nothing for it (#3269). On `/settings/capacity` the row of each such setting
carries one muted line, "changed from X N days ago by who", and its **Put back**
button (in the row's own form, beside Save) restores the default through
`changeCapacity` (same validation, record, event and reversal). The line stays
until the value is back at the default; nothing else reminds anyone. The
JSON API and MCP carry the same fact: a setting away from its default has a
`changed` field (`at`, `by`) in the capacity listing (`listCapacity`).

The `setting:<key>` findings filed before that are all closed; none raises an
ask, and the capacity page's Put back is the one answer. The `sentinel_kept`
table they once used is unread; a migration drops it once the additive rule
(`test/schema-additive.test.ts`) allows a drop.

**What it never quotes.** Evidence passes through `scrub` (`redactSecrets` and
any 32-character unbroken token) before it is filed, since the repository may
be public.

**Not done.** Ingress routes and other edge objects are not in this database,
so the sentinel cannot see them. It does not open fix pulls: a finding with a
mechanical fix says what it is, and a crew run takes the issue up. Direction at
its cap and WARN lines are not read yet.
