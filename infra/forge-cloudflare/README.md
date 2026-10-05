# infra/forge-cloudflare

One forge behind a Cloudflare Worker front door: a Worker, one Durable Object
(`Forge`) that forwards to the body and answers `/healthz` itself when the body
is down, a proxied DNS record, and — when `body_url` is empty — a tunnel for a
body with no public address. Every name starts `spike-`; the variable
validation refuses any other.

```
export CLOUDFLARE_API_TOKEN=…  AWS_ACCESS_KEY_ID=…  AWS_SECRET_ACCESS_KEY=…
tofu init -backend-config=backend.hcl   # bucket, key=spike-<name>/tofu.tfstate, endpoints.s3, region
tofu plan  -var name=spike-a -var account_id=… -var zone_id=… -var zone_name=… -var body_url=https://…
tofu apply …                            # then: curl $(tofu output -raw url)/healthz  and /mcp
tofu destroy …                          # always, when done
```

The credentials are the run's declared secrets (`docs/APPS.md`, _Forge
secrets_); none is in this directory. State is locked with a lock object in the
bucket (`use_lockfile`).

**Not here:** the Container body. The Cloudflare provider has no Containers
resource, so that body is deployed with `wrangler` and its URL given as
`body_url`. See `docs/SPIKE-CLOUDFLARE.md`.

## Run it on celld

The same `worker.js`, unchanged, runs on [celld](https://github.com/denoland/celld)
from `wrangler.json` — no Cloudflare account, no Docker, no bucket. A child forge
can have its front door on our own machines.

```
bun -e 'import {celld} from "./scripts/celld"; console.log(await celld())'   # path of the pinned binary
echo 'BODY_URL=http://127.0.0.1:8080' > infra/forge-cloudflare/.dev.vars     # the body; overrides wrangler.json
$(that path) dev infra/forge-cloudflare --port 9876                          # esbuild must be on PATH
```

`wrangler.json` holds only keys celld accepts, no secret and no real hostname;
its `BODY_URL` is a loopback placeholder, and `.dev.vars` overrides it. The
Durable Object migration is `new_sqlite_classes` (celld refuses `new_classes`).
`scripts/celld.ts` fetches release **v0.6.1** only, checks a SHA-256 written in
the script, and caches the binary under the temp dir (linux x64/arm64, macOS
arm64; any other platform is an error). celld is a beta whose releases break
compatibility, so an upgrade is a deliberate pull: change the version and
digests together and run `test/forge-cloudflare-celld.test.ts`. That test skips,
saying why, when the download fails or `esbuild` is missing, and is not in the
`forge.json` gate.

Measured on a 4-vCPU x86_64 Linux VM (DO-Regular), celld 0.6.1, stub body on
loopback, esbuild 0.28.2:

| | |
|---|---|
| Cold start: `celld dev --clean` spawned → first request answered | ≈ 2.0 s |
| Next request | ≈ 150 ms |
| p50 over 100 requests, through the Worker and Durable Object to the body | ≈ 29 ms |
| p99 | ≈ 126 ms |
