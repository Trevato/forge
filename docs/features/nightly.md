# Nightly jobs

The forge runs two jobs itself, at a fixed UTC slot each (`src/nightly/jobs.ts`):

- **flake-hunt, 02:17.** The gate in 20 slices, five loaded runs each, then the quarantine. Files `Flaky:` issues and proposes the quarantine as a pull on `flake-hunt/<date>`.
- **outside-gate, 03:47.** Every file in `EXCLUDED` once. Opens, updates and closes `Red:` issues.

Both are `scripts/flake-hunt.ts`, run in a cell on a checkout of the default branch that reaches only the forge and the registry. Only steps that file hold `FORGE_TOKEN`.

## Seeing it

Resilience (admins) and the terminal's Resilience dialog say, per job, when it last ran and what it filed or why it did not run. The record is `FORGE_APP_DATA/nightly/<job>.json`.

## When it runs

One job at a time. A job queued behind another keeps its own slot. A forge that was down at a slot runs the job on waking; a restart mid-run does not run it twice, and the record says the run was stopped. Off in a preview, without `FORGE_TOKEN`, and where cells do not work.

## Trying it

With a token and cells, a job runs when its slot comes. To run one now from a test or a console: `startNightly(app, { forgeUrl, token })?.run("outside-gate")`.

## What the Forgejo workflows were

`flake-hunt.yml` and `outside-gate.yml` stay on the mirror until the forge's own run has filed one real result. Both dedupe on the open `Flaky:` and `Red:` issues, so they cannot double-file; the pull that deletes them carries one night's output from each side. `sync-env.yml` sealed the repository's Actions secrets into the platform's `forge-user-env` Secret, which fed the pod's environment (the crew's Claude credential, `FORGE_TOKEN`). The forge already holds its own secrets, so there is nothing to port: the Secret goes with the pod (`docs/PLATFORM.md`, rows 2 and 3).
