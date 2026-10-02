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
