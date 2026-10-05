# Spike: a forge on Cloudflare, spawned with OpenTofu (#339)

**Status: the module is written and its front door is tested; nothing has been
applied.** This run had no `tofu` binary, no Cloudflare token and no bucket
credential (the run-secret injection it depends on was not declared for it), and
no `bwrap`. So `tofu plan`, `apply` and `destroy` are unproven, and each open
question below says whether it is *evidence* or *reading*. Nothing here claims
a measurement that was not made.

## What exists

`infra/forge-cloudflare/`: Worker + Durable Object front door (`worker.js`,
tested in `test/forge-cloudflare.test.ts`), proxied DNS record, optional tunnel
for a body with no public address, S3 backend with `use_lockfile` and a
per-forge key. Names must match `^spike-…`, so the module cannot address the
production tunnel or zone records. Every record carries a comment naming the
spike. The provider (v5) syntax was written from memory and is unchecked by
`tofu validate`.

Gap found: the Cloudflare provider has no Containers resource, so a Container
body is deployed with `wrangler` and passed in as `body_url`. "Apply produces a
forge" therefore needs two tools for that body, one for Fly (`fly deploy`).

## The five questions

| Question | Answer | Basis |
| --- | --- | --- |
| bubblewrap inside the container | **Unknown; probably no.** `src/crew/sandbox.ts` probes `bwrap --unshare-user` and falls back to unsandboxed. Containers run in a VM without user-namespace privileges we control; expect the probe to fail. Check: run the probe in a Container. | reading |
| SQLite WAL across snapshot/restore | **Unknown.** A disk snapshot taken mid-write holds a consistent main file plus `-wal`, which SQLite recovers on open, provided both are captured together. The forge's own snapshot (`docs/SNAPSHOT.md`) does not depend on disk snapshots, so restore via S3 sidesteps the question. | reading |
| HTTPS git instead of SSH | **Yes for the forge's clients.** Inbound is HTTP only on Containers, so `FORGE_SSH_PORT=0` and clone/push over HTTPS with tokens. The app terminal (`FORGE_APP_SSH`) is off there. Fly keeps SSH. | reading |
| Does a crew run keep the container awake past 10 min idle | **Unknown.** Idleness is measured on inbound requests; a run is outbound work inside the container, so assume it does *not* count. Mitigation to test: the Durable Object pings the body every few minutes while a run is open, or `sleepAfter` is raised. | reading |
| 30-day snapshot retention | **Fine for a cache, wrong for a record.** The nightly S3 snapshot is the record; the platform snapshot is a warm-start only. | reading |

## Verdict (provisional)

- **Container body:** right for a forge that is mostly idle, small, and used
  from a browser: zero idle cost. Wrong for a forge whose crew runs long, wants
  bwrap, or wants SSH.
- **Fly:** the default for a forge people work in daily: a volume, raw TCP for
  SSH, a full VM (bwrap likely works), scale-to-zero still available.
- **Firecracker on metal:** only when many forges share hardware and need
  kernel isolation between them (`docs/EXTRACT.md`, _What is given up_); more
  to run than a spike warrants.

Both bodies sit behind the same Worker front door, so choosing later costs a
variable, not a rewrite.

celld could run that front door on our own machines; see
`docs/research/celld.md`.

## To finish the spike

1. Declare the Cloudflare token and bucket key as run secrets; install `tofu`.
2. `tofu init/validate/plan/apply` with `spike-` name; fetch `/healthz`, `/mcp`.
3. Run the bwrap probe, hold a run past 10 minutes, kill and restore the volume.
4. `tofu destroy`, then confirm the zone and account list nothing tagged `spike-`.
