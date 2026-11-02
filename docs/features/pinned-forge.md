# A pinned forge (#8697)

A pinned forge is a forge the owner put on their own cloud. It has **no crew** and **no automatic release**. Its version and config change only through one explicit `Update`, recorded with who and when; `Rollback` is one action to the previous version.

## Doors (forge admin, admin-scope token)

- HTTP: `GET /api/v1/admin/pinned` (forges, their changes, the targets), `POST /api/v1/admin/pinned` (deploy), `POST /api/v1/admin/pinned/:name/update`, `POST /api/v1/admin/pinned/:name/rollback`.
- Terminal: palette → **Pinned forges** (forge admin): `d` deploy, `u` update, `r` roll back; it follows the bus, so a change made at any door shows at once (`src/tui/screens/pinned.ts`).
- MCP: `pinned_forge` with `verb` `list`, `deploy`, `update`, `rollback` — the same words and the same checks (`src/actions/pinned.ts`).

A deploy names a cloud account (Settings → Cloud accounts, **writes allowed**), the app (`owner/name`), a git `source` (https) and a `version` (a 40-character commit id or a tag like `v1.2.3` — never a branch, so nothing moves under it).

## Why it cannot move on its own

`pinned_forge.version` and `.config` are guarded by a SQLite trigger (migration `20261103090000-pinned-forge`): an UPDATE passes only with a `change_id` that points at a newer `update` or `rollback` row in `pinned_change` whose target is exactly the new version and config. `pinned_change` cannot be updated or deleted. `crew` and `auto_release` are CHECKed to 0. `test/pinned-forge.test.ts` tries each other way and fails if one works. A pinned forge is a row and a droplet, not a repository on this forge, so the crew, the release keeper and upstream following have nothing of it to touch.

## Credentials

The cloud token stays sealed. It is opened for the one call that needs it (a `secret.read` event names the run), sent as an `Authorization` header over HTTPS, and never reaches argv, a row, an event, a request body or the boot script. The boot script holds no secret: the new forge's first visitor claims it. Config refuses names that look like secrets.

## Targets: what runs, what it costs, what is refused

Prices are list prices as last read (USD a month); the owner's own bill is the truth. Source of truth in code: `src/cloud/targets.ts`.

| Target | Status | What runs | Cost | Refused / caveat |
|---|---|---|---|---|
| DigitalOcean | **deploys today** | One droplet (`s-1vcpu-2gb`, Ubuntu 24.04) with a 10 GiB block volume as `FORGE_APP_DATA`. An Update deletes the droplet and starts a new one on the same volume, so data is untouched. | ~$12 + ~$1.20 | A token cannot be narrowed below "create droplets and volumes". |
| AWS | not written | EC2 `t4g.small` + EBS gp3, same boot script; SigV4 already exists for reads. | ~$12 + ~$0.80 + public IPv4 ~$3.65 | Wants a role scoped to a tag rather than a long-lived key. |
| Azure | not written | B1ms VM + managed disk through a service principal on one resource group. | ~$15 + ~$1 + public IP ~$3.65 | Needs a resource group, network and public IP first: three calls more. |
| Cloudflare | **refused** | Workers/Durable Objects keep state, but not as files a Bun process opens. Containers run, with a disk wiped on sleep or replace. | Workers Paid from $5 | No volume that survives; the forge refuses rather than lose repositories quietly. |
| Vercel | **refused** | Functions and Sandboxes: short-lived, scratch disk. | Pro from $20/seat | No long-running process, no persistent disk. Vercel can host an app a forge ships, not the forge. |

The cloud facts for Cloudflare and Vercel are from memory of their documentation, last written 2026-11-02; check them before relying on a refusal for a decision beyond this forge.

## Prior art

Open-source "Deploy to" buttons (Heroku's `app.json`, Render's `render.yaml`, DigitalOcean's App Platform button, Railway templates) are a link carrying a repository and a settings file to a provider's sign-in. That is the shape for the button: a link with `app`, `source`, `version` that lands on the Deploy form after one sign-in. The older `deploy/` cloud path and the child-forge path (#4416, #2928, #3785) are the other prior art; neither pins.

## Failing half-way

Each id is recorded the moment it exists. A first deploy that fails before a droplet exists leaves a `failed` row with the volume's id; deploying the same name again reuses that volume. An Update deletes the old droplet and clears its id at once; a 404 on that delete counts as deleted, so after a failed create a Rollback or another Update goes straight to creating. A `failed` forge may be told the version it already has, to finish the replacement. The droplet installs the Bun in `BUN_VERSION` (`src/cloud/droplet.ts`), so the runtime moves only when a pull moves it.

## Not done

- No canary on a real account: #8746.
- No `Deploy to…` page or link: #8744.
- The droplet's address is not read back, so no URL is shown, no TLS or domain, no health check: #8745.
- AWS and Azure drivers.
