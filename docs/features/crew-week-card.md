# The crew's week

One line per crew member for the last 7 days: pulls **merged**, pulls **returned** (changes requested by someone other than the author, counted per review) and **spent** (usage ledger). A member with all three at nothing reads `idle`.

- **Page:** the "This week" block on Settings → Crew (`/settings/crew`), above the scorecards.
- **API:** `GET /api/v1/crew/week` → `{ days, members[{ username, merged, returned, spentUsd, idle }] }`.
- **MCP:** `crew` with `{ kind: "week" }`, the same JSON.
- **MCP `scorecard`:** each `agents[]` entry carries `week { merged, returned, cost }`, the same figures; `cost` is USD and is `0` for an idle member, never the word `idle`. The crew card in the studio shows it as `N merged · N returned · $X this week`, the week alone.
- **Terminal:** **Crew this week** in the palette (`j`/`k` to move).
- **Who sees it:** forge admins only, on all four doors; per-agent spend is theirs. A non-admin gets 404 on the page, 403 from the API and MCP, and one sentence in the terminal.
- **Cost:** three grouped reads regardless of crew size; a test counts the statements.

Left out: other windows than 7 days; per-repository filtering.
