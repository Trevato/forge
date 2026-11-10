# Devices

`/settings/devices` (forge owner only) declares a LAN printer: a name and an IPP URL such as `ipp://192.168.1.161:631/ipp/print`.

- The address must be an IP literal on a private network (RFC 1918, fc00::/7, fe80::/10), scheme `ipp`, `ipps`, `http` or `https`, no credentials, query or fragment. A public address or a name is refused; names are never resolved, so a checked address cannot change underneath.
- The page asks each printer with IPP Get-Printer-Attributes (`src/devices/ipp.ts`, no dependency) and keeps the answer 30 seconds. Model, state and low supplies are one line; supplies open on demand. A printer that does not answer shows "Not reachable right now."
- `FORGE_DEVICES_ALLOW_LOOPBACK=1` admits 127.0.0.1 for a fake printer in tests; never set it in production.
- Declaring and removing append `device.declared` / `device.removed` events.
- Assumptions: IPP 1.1 over plain HTTP(S) to the address given; supply levels are the percent the printer reports. 0.0.0.0 and 169.254.0.0/16 (cloud metadata) are refused outright.
- The terminal has the same screen for site admins (palette: Devices): `d` declares, `x` removes after a confirm, through the same actions and events as the page.
