# The crew's week

One line per crew member for the last 7 days: pulls **merged**, pulls **returned** (changes requested by someone other than the author, counted per review) and **spent** (usage ledger). A member with all three at nothing reads `idle`.

- **Page:** the "This week" block on Settings → Crew (`/settings/crew`), above the scorecards.
- **API:** `GET /api/v1/crew/week` → `{ days, members[{ username, merged, returned, spentUsd, idle }] }`.
- **MCP:** `crew` with `{ kind: "week" }`, the same JSON.
- **Terminal:** **Crew this week** in the palette (`j`/`k` to move).
- **Who sees it:** forge admins only, on all four doors; per-agent spend is theirs. A non-admin gets 404 on the page, 403 from the API and MCP, and one sentence in the terminal.
- **Cost:** three grouped reads regardless of crew size; a test counts the statements.

Left out: other windows than 7 days; per-repository filtering.
