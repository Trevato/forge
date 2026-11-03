# Extract — the forge on its own machine, and open-platform switched off

The forge already runs anywhere `bun` and `git` do; the platform around it
today (Forgejo, Kubernetes, Flux, Kyverno, Cloudflare's edge) is what
_built and served_ the forge, not what the forge needs. This is the order
of moves that takes the forge out of open-platform and lets the platform be
turned off, with what each move costs and what it gives up.

## What a host owes the forge

- **Binaries**: `bun`, `git`, `claude` (the crew), `chromium` (the look), and
  `tofu` where a run spawns another forge (`infra/forge-cloudflare`,
  `docs/SPIKE-CLOUDFLARE.md`).
- **A name and a wildcard**: `forge.example` for the forge, `*.forge.example`
  for the apps it serves (`FORGE_APP_DOMAIN`). One wildcard certificate
  covers them; the forge speaks plain HTTP on `:3000` and expects a proxy in
  front to hold TLS — Caddy with a DNS challenge, or the Cloudflare tunnel
  the platform already uses, pointed at the box instead of the cluster.
- **Ports**: `:3000` behind the proxy; `:2222` open when git over SSH is
  wanted (`FORGE_SSH_PORT=0` turns it off).
- **A bucket** for the nightly snapshot (`S3_*`, `docs/SNAPSHOT.md`); B2 is
  what the platform uses today and the same bucket keeps working.
- **The crew's accounts**: `CLAUDE_CODE_OAUTH_TOKEN` for one, or the
  Subscriptions page for several (`docs/APPS.md`, _Subscriptions_), and
  `FORGE_CREW_CEILING_USD` for the day's bound.

## The move, in order

1. **A box.** An 8 GB droplet is enough for this forge as it runs now (it
   idles under a gigabyte since apps sleep); the DGX Spark is the same
   recipe with no network story. Install the four binaries; make
   `/var/lib/forge` and a user that owns it.
2. **Restore, don't migrate.** The nightly snapshot holds everything that
   cannot be rebuilt — the database, every repository, every app's
   production data, the crew's logs — and the forge's key only wrapped under
   the operator's passphrase. On the new box, with the same `S3_*` variables
   and the passphrase the old forge ran with:
   `FORGE_SNAPSHOT_PASSPHRASE=… bun run src/snapshot/restore.ts <snapshot> /var/lib/forge`
   The restore unwraps the key and sets its mode; sealed variables, secrets
   and sealed subscriptions keep working. The passphrase lives in the forge's
   environment and with the operator — keep a copy outside the bucket. Without
   it repositories and issues restore, and every sealed value is listed by
   name as lost and must be set again (`docs/SNAPSHOT.md`).
3. **Run it as a service.** A systemd unit: `ExecStart=bun run src/main.ts`
   from a checkout at `/opt/forge`, `FORGE_URL=https://forge.example`,
   `FORGE_APP_DOMAIN=forge.example`, `FORGE_DATA=/var/lib/forge`, the crew
   variables, `Restart=always`. Apps come back asleep and wake on request;
   production apps start warm.
4. **The proxy.** Caddy:
   `forge.example, *.forge.example { reverse_proxy 127.0.0.1:3000 }` with a
   DNS-challenge wildcard, or the existing Cloudflare tunnel with two ingress
   rules to `http://127.0.0.1:3000`. Either way the forge sees
   `x-forwarded-proto` and answers with its canonical URL. An app's own
   domain (`docs/APPS.md`, _Your own domain_) is a name the wildcard does
   not cover, so Caddy fetches its certificate on demand — after asking the
   forge whether the name is anyone's:

   ```
   {
     on_demand_tls {
       ask http://127.0.0.1:3000/__forge/domains/ask
     }
   }
   forge.example, *.forge.example {
     reverse_proxy 127.0.0.1:3000
   }
   https:// {
     tls { on_demand }
     reverse_proxy 127.0.0.1:3000
   }
   ```

   The forge answers the ask with 200 for a verified domain and 404 for
   anything else, so nobody can make the proxy fetch certificates for names
   that are not here. With the tunnel, each domain is one more ingress rule
   to the same address.

5. **DNS cutover.** Point `forge.example` and the wildcard at the box (or
   the tunnel). The old cluster keeps serving until the switch; after it,
   the platform's forge is a copy nobody visits.
6. **Updates without Forgejo.** The forge hosts its own source: the
   repository the crew works on _is_ upstream now, and Propose upstream is
   how a person's work reaches it. A timer on the box does what
   `release_app` did — `git -C /opt/forge pull --ff-only
https://forge.example/trevato/forge.git main && systemctl restart forge`
   — once an hour, or on a tag if you want releases to stay deliberate.
   The forge pulling its own repository from itself is the same shape
   Forgejo has always had.
7. **Bring the apps.** Every app on the platform that is not already on the
   forge comes in through **Migrate** (`docs/ORIGINS.md`), with a crew on
   the ones that should deploy. The Forgejo origin stays connected until the
   last one is in; then it is disconnected and the mirrors go.
8. **Switch open-platform off.** Once nothing points at the cluster: stop
   the droplet's standby lanes, snapshot the platform's own state to B2
   once, and power it down. Keep the DNS zone; drop the rest.

## What is given up, plainly

- **Kernel-level isolation between apps.** The platform ran each app in its
  own namespace under restricted pod security, default-deny network policy
  and a quota. The forge runs apps as processes on one box, and the crew's
  shells under bwrap. For one person's apps this is fine; before friends'
  apps share a box, apps need their own sandbox (bwrap or a microVM per
  app), and that is the one piece of platform worth rebuilding inside the
  forge.
- **Postgres and object storage per app.** Forge apps keep SQLite under
  `FORGE_APP_DATA`; an app that needs a bucket needs the forge to hand it
  one, which it does not yet.
- **Dashboards.** No Prometheus, no Grafana. The forge's own pages —
  Crew, the audit, the ledger — are the observability it has; a
  `/metrics` for the forge itself is a small addition if wanted.
- **A CI runner.** Checks run inside the forge's process, which is faster
  and what the crew already relies on; there is no separate runner to fail.

## What is not lost

The edge sign-in becomes the forge's own sign-in and grants. Zero-downtime
deploys become the forge's swap. Backups become the snapshot. TLS becomes
the proxy's. The crew, the studio, the contracts, the audit, the following —
all of it already lives in the forge and moves with the data.

## The box beside production

Steps 1–3 as files: `scripts/box-install.sh` (user, `/var/lib/forge`,
`/etc/forge/forge.env`, checkout at `/opt/forge`, `bun install`, the unit) and
`infra/forge-box/forge.service` (`Restart=always`, enabled at boot, so a
killed process or a reboot brings it back). Then the lines of
[RESTORE.md](RESTORE.md) with `<data-dir>` = `/var/lib/forge` as the `forge`
user, and `systemctl enable --now forge`. Nothing points at the box; compare
repository and app counts with production, kill the process and reboot to see
it return. Restoring reads the bucket by the card's lines only — no platform
service is involved. `test/forge-box-unit.test.ts` parses the unit.
Done on a machine: the drill itself (restore, counts, reboot) is the owner's to run.
