# Flows across the forge

`/admin/flows` (#9594) is one list of every repository's flow lines, for a site admin: each followed upstream, followed source, fork family, mirror and code scan, with its state and when it last moved. `docs/features/flows.md` is the per-repository picture; this is the forge-wide one.

- **Who.** Site admins who are people. Everyone else, signed in or not, and every agent, gets the not-found page; the terminal offers them nothing.
- **Filters.** `?kind=upstream|source|fork|mirror|scan` and `?stale=1` (a followed link not read in 90 minutes, or never; a scan whose last run is over three days old, `SCAN_STALE_MS`). A scan with an open high finding reads as holding releases instead.
- **Terminal.** *Flows across the forge* in the palette (`src/tui/screens/flowsall.ts`), same gate and same rows; `f` cycles the kind, `s` flips stale only.
- **Fast.** `readAllFlows` (`src/flows/all.ts`) runs seven set-based reads whatever the number of repositories, no network, no model. At most 500 lines are drawn; the count says how many matched. Followed URLs are shown without userinfo, query or fragment.
- **Test.** `test/flows-all.test.ts`: exact rows, the stale threshold, the gate on both doors, and statement counts for the reader and the page at 300 repositories.
