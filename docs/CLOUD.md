# Clouds are capacity, never dependency

The rule:

1. **The forge runs, backs up and restores with no vendor attached.** Every
   vendor is an addition; unplugging all of them leaves a working forge.
2. **What leaves through a vendor is end-to-end encrypted or already public.**
   A vendor never holds a readable secret, session or private repository.
3. **Every use is declared and has a way back.** Nothing reaches a vendor
   unless `cloud.json` says so, and each use names how to leave it (`why`
   says what it is for; the module that makes the call documents its exit).

## `cloud.json`

Beside `forge.json`, at the root of the repository:

```json
{ "uses": [{ "vendor": "s3", "use": "backup", "why": "off-machine copy of the encrypted snapshot" }] }
```

- `vendor`: `cloudflare`, `fly`, `hetzner`, `s3`, `github`, `vercel`, `digitalocean`, `azure` or `stripe`.
- `use`: `compute`, `storage`, `backup`, `dns`, `cdn` or `payments`. The forge declares `stripe`/`payments` for itself (`FORGE_STRIPE`): `api.stripe.com`, for connecting (its webhook endpoint), and nothing else.
- `why`: one line, up to 300 characters.

No file means no uses. A malformed file is refused with one sentence
(`parseCloud`, `src/apps/manifest.ts`) and grants nothing.

## The gate

`mayUse(declared, vendor, use)` in `src/apps/cloud.ts` is the only way a
vendor call is allowed. Later steps call it before every vendor request; it is
false unless that exact vendor and use are declared.

A key attached under Settings → Cloud accounts is handed to a run only when
the run's repository declares the key's vendor. A provider's vendor is
`VENDOR_OF` in `src/cloud/providers.ts`: the provider's own name, except that
AWS and Backblaze B2 are `s3` (both speak the S3 interface).

## Cloud accounts

**Settings → Cloud accounts** (admins) holds provider keys — Cloudflare,
DigitalOcean, AWS, Azure, Fly, Backblaze, GitHub, Vercel — sealed and write-only. Pasting one
makes the forge check it with read-only calls (listed in the header of
`src/cloud/providers.ts`) and say what it can see; a key the provider rejects
is not stored. It is sealed at forge scope as `CLOUD_<PROVIDER>_<NAME>` (secret
names are capitals, so `cloudflare/main` is `CLOUD_CLOUDFLARE_MAIN`). The page
lists names, the last check, and which run last opened each key; "Every read"
lists each open, and a run's page lists the secrets it held. A run gets a key
by declaring it like any secret. **Write allowed** is off by default: a run
that adds `writes: yes` to its front-matter and declares a cloud key whose
switch is off fails with that reason. The switch gates the forge's hand-out,
not the key — a provider key that can write still can, so paste read-only keys.
**Audit** reads one account and opens one `[audit]` issue per finding (unattached
volumes, powered-off droplets, unassociated IPs, never-active zones) with a
monthly saving estimate, skipping findings already open. It runs in the forge,
not as a crew run; AWS audits look at us-east-1 only; over-provisioned
droplets and forgotten DNS records need metrics or resolution and are not
attempted; Backblaze, GitHub and Vercel audits find nothing yet. No dependency was added.

Each account can be **rotated** (the new value is checked, then replaces the
old) and **renamed** (re-sealed under the new name, write switch kept). Each
says in one line what it is used for now — the `cloud.json` declarations on
the default branch of the first 100 repositories the admin can see, cached a minute — and
carries a "bring it home" note (`HOME` in `src/cloud/declared.ts`). Every
vendor request goes through `src/cloud/gate.ts`: an admin's verify or audit is
audited as the operator; a hand-out of a key to a run is allowed only if that
repository's `cloud.json` declares the key's vendor (`VENDOR_OF`: the provider's name, but AWS and Backblaze are `s3`), and an undeclared one is
refused before the key is opened. One `cloud_audit` row per request (account,
purpose, host and path, bytes out, when, allowed or refused — no token, no
query) is listed at **Settings → Cloud accounts → Every vendor call today**.
Rows are pruned past 90 days on every write; `at` is indexed. Left out: one
token per vendor is not enforced (several names per vendor stay allowed), and
an agent's own vendor calls beyond the hand-out are not metered. A forge admin reaches the same accounts in the terminal (`:` → Cloud accounts: each account with what it is used for, verified / last used and today's vendor calls; `a` attach, `v` verify, `r` rotate, `n` rename, `x` remove, `w` flip the write switch, `A` audit into an `owner/repo`, `c` every vendor call today (purpose, host and path, bytes out, allowed or refused), the token typed masked) and over MCP (`cloud_accounts` lists them with today's audit rows; `cloud_account` with `verb` attach, verify, rotate, rename, remove, `allow_writes` (with `allowed`) or `audit` (with `repo`) needs an admin-scope token). Both call `actions/cloud.ts`, neither ever shows a token, and anyone else is refused. A rename is refused when the account or the secret `CLOUD_<PROVIDER>_<NAME>` already exists.
