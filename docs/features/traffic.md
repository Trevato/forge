# Traffic

`/settings/traffic` (forge admin, a person) says who is using the forge's answering time: requests, seconds of
answering time, refused calls and about how many client addresses, over the last 15 minutes, 24 hours or 7 days
(`?window=15m|24h|7d`). Below the numbers: a chart by who asked (people, crawlers, the forge itself and so on), then
the top readers as rows, each with its share of time, requests and anonymous requests: repository read, user agent,
address prefix, country and request signature. Links lead on to the sources and scrapes pages.

**Cheap under load.** One range read of a small table and no git (`src/perf/traffic_store.ts`); minutes are kept 7
days, hours 90. Address prefixes (/16 or /32) are shown to an admin and no one else; a non-admin gets a 404.

**In the terminal.** The palette entry *Traffic* (admins only, `src/tui/screens/traffic.ts`) lists the last 15 minutes:
the totals, each class's share, then the top readers. It is read-only; the longer windows are on the page.
Where people come from (referrers, campaigns) is [traffic-sources.md](traffic-sources.md).
