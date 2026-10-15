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

- `vendor`: `cloudflare`, `fly`, `hetzner` or `s3`.
- `use`: `compute`, `storage`, `backup`, `dns` or `cdn`.
- `why`: one line, up to 300 characters.

No file means no uses. A malformed file is refused with one sentence
(`parseCloud`, `src/apps/manifest.ts`) and grants nothing.

## The gate

`mayUse(declared, vendor, use)` in `src/apps/cloud.ts` is the only way a
vendor call is allowed. Later steps call it before every vendor request; it is
false unless that exact vendor and use are declared.
