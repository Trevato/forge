# Devices

`/settings/devices` (forge owner only) declares a LAN printer: a name and an IPP URL such as `ipp://192.168.1.161:631/ipp/print`.

- The address must be an IP literal on a private network (RFC 1918, fc00::/7, fe80::/10), scheme `ipp`, `ipps`, `http` or `https`, no credentials, query or fragment. A public address or a name is refused; names are never resolved, so a checked address cannot change underneath.
- The page asks each printer with IPP Get-Printer-Attributes (`src/devices/ipp.ts`, no dependency) and keeps the answer 30 seconds. Model, state and low supplies are one line; supplies open on demand. A printer that does not answer shows "Not reachable right now."
- `FORGE_DEVICES_ALLOW_LOOPBACK=1` admits 127.0.0.1 for a fake printer in tests; never set it in production.
- Declaring and removing append `device.declared` / `device.removed` events.
- Assumptions: IPP 1.1 over plain HTTP(S) to the address given; supply levels are the percent the printer reports. 0.0.0.0 and 169.254.0.0/16 (cloud metadata) are refused outright.
- The terminal has the same screen for site admins (palette: Devices): `d` declares, `x` removes after a confirm, through the same actions and events as the page.

## Printing from an app

- On a device's row ("Allowed apps") the owner grants it to an app by slug, and revokes it again (`device.granted` / `device.revoked` events). No grant, no print. In the terminal's Devices screen, `a` allows the device under the cursor to an app (type its slug) and `r` revokes one; the same actions and events as the page.
- An app prints with `POST $FORGE_API_URL/devices/<id>/print`, `Authorization: Bearer $FORGE_TOKEN`: the app process's own token, body the PDF (`content-type: application/pdf`). The forge knows the app from `app_token`, which only the runtime writes when it mints that token; a person's token named like an app is not one. The reply is `{"job":{"id","state","reasons"}}` from the printer's IPP Print-Job answer.
- Checked before anything leaves for the LAN: at most 10 MB and 20 pages, `%PDF-` header and `%%EOF` trailer, otherwise 422. Pages are counted from the plain page tree; a PDF whose tree is in a compressed object stream answers 422 `pages_unknown`. Not granted, or not a declared device: 403. Printer silent or refusing: 502.
- The route takes a device number only; the job goes to the declared address, so an app reaches no other LAN host through it. Its cell's own egress is unchanged (`src/apps/egress.ts` still opens only granted `host:port`s).
- Each print appends `device.printed` (device, app, pages).
- The app and grant are checked before the body is read, so a caller without a grant costs a lookup, not 10 MB. An app may start 10 prints a minute and have 2 in flight; past that, 429 `rate_limited`.
- A PDF containing an object stream (`/ObjStm`) answers 422 `pages_unknown`: the page tree could hide there behind a plain decoy.
- A token minted before this feature has no `app_token` row, so a running app gets 403 until it restarts and mints a fresh one.

## Daily limit and the print log

- Each grant has a daily cap on jobs, default 10, set by the owner from 0 (no prints) to 1000. Jobs that reached the printer (printed or failed there) count, per UTC day; a refusal never uses up the day. Past the cap the app gets 429 `daily_cap` and can print again after midnight UTC. In-flight jobs count, and a place is reserved before the body is read, so parallel requests cannot slip past the last one.
- Every job is a row in `print_job` (app, device, pages, outcome, time). A cap refusal is written once per app, device and day; refusals are pruned to the last 100 per device and counted rows are dropped after 30 days, so a caller cannot grow the log.
- The device page shows "n of cap printed today" per app, a "Daily limit" row to set it and a "Recent prints" row (last 10). In the terminal's Devices screen `l` sets the limit (slug, then number) and each row lists the last 5 prints; both doors use `setCap`, admin only, and append `device.cap_set` (device, app, cap).
