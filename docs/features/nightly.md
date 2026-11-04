# Nightly jobs

The forge runs two jobs itself, at a fixed UTC slot each (`src/nightly/jobs.ts`):

- **flake-hunt, 02:17.** The gate in 20 slices, five loaded runs each, then the quarantine. Files `Flaky:` issues and proposes the quarantine as a pull on `flake-hunt/<date>`.
- **outside-gate, 03:47.** Every file in `EXCLUDED` once. Opens, updates and closes `Red:` issues.

Both are `scripts/flake-hunt.ts`, run in a cell on a checkout of the default branch that reaches only the forge and the registry. Only steps that file hold `FORGE_TOKEN`.

## Seeing it

Resilience (admins) and the terminal's Resilience dialog say, per job, when it last ran and what it filed (`filed #12, closed #4, quarantined test/x.test.ts`, or `filed nothing`) or why it did not run. The record is `FORGE_APP_DATA/nightly/<job>.json`. What it filed is read from the hunt script's own lines (the tests it runs print to the hunt, not to the output), so it is what the default branch's script says it did: advisory, the issues are the truth.

Each line links to the job's newest output, `/resilience/nightly/<job>` (admins): every step's command and what it printed, kept in `FORGE_APP_DATA/nightly/<job>.log`, replaced by the next run and cut at 1 MB. In the terminal's Resilience dialog `o` shows the tail of each. It is the run a `Flaky:` or `Red:` issue names (`FORGE_RUN_URL`), where the Forgejo jobs named their Actions run.

## When it runs

One job at a time. A job queued behind another keeps its own slot. A forge that was down at a slot runs the job on waking; a restart mid-run does not run it twice, and the record says the run was stopped. Off in a preview, without `FORGE_TOKEN`, and where cells do not work.

## Trying it

With a token and cells, a job runs when its slot comes. To run one now from a test or a console: `startNightly(app, { forgeUrl, token })?.run("outside-gate")`.

## What the Forgejo workflows were

`flake-hunt.yml` and `outside-gate.yml` stay on the mirror until the forge's own run has filed one real result. Both dedupe on the open `Flaky:` and `Red:` issues the token's own user filed, so they cannot double-file while the forge's `FORGE_TOKEN` and the mirror's secret act as the same user (the Forgejo hunt's issues are Mason's); with two users, each files its own, which is the comparison in plain sight. The pull that deletes them (#9020) carries one night's output from each side.

`sync-env.yml` sealed the repository's Actions secrets into the platform's `forge-user-env` Secret, which fed the pod's environment (the crew's Claude credential, `FORGE_TOKEN`). The forge already holds its own secrets, so there is nothing to port: the Secret goes with the pod (`docs/PLATFORM.md`, rows 2 and 3).

### Comparing one night

For one date, set side by side:

- **Forgejo:** the `flake-hunt` and `outside-gate` Actions runs on the mirror (each slice's log, the quarantine job's log).
- **Forge:** `/resilience/nightly/flake-hunt` and `/resilience/nightly/outside-gate`, and the line above each: what it filed.

They agree when the outside run lists the same files green and red, both open, update and close the same `Red:` issues (or one finds the other's already open), and the hunt's flaky files, which vary with the seed, are each filed once. `bun scripts/flake-compare.ts --forge <log>… --forgejo <log>…` does this from the logs and names each difference (`docs/DEVELOP.md`). A file red on one side and green on the other is the finding: the cell (no network but the forge and the registry, its CPU and memory caps) differs from the `isolated` runner.
