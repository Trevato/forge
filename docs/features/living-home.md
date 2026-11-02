# The living home (#8015)

Signed in, `/` is five things and nothing else:

1. **The box** — one line that tells the crew (`POST /tell`, the same action the feed's composer posts to). A phone's share sheet fills it.
2. **The figures** (admins) — the KPI tiles and any alarm, one calm line each. Everyone else gets the live version line.
3. **Now** (site admins) — `check › review › land › live`, each the sum of the `/boards` stages it names (`nowOf` in `src/flow/moving.ts`), each a link. The counts take in every repository, private ones too, so no one else is shown them.
4. **Being built / Just shipped** — three rows each, every row a link to its issue or pull, read for the viewer (a repository they cannot read, and a sealed report, are never named). One live region, `#live-moving`, redrawn from `/live/moving` when a run or a merge moves; it always holds six rows, so nothing below it shifts.
5. **Your apps** — a chip per app and a plus; `#live-chips`, redrawn from `/live/chips`.

The terminal's home carries the same lines (`movingLines` in `src/tui/screens/moving.ts`): Now for a site admin, then being built and just shipped, read for the viewer; its tell is the box.

The feed — the composer, the timeline, what is on you, since you were here, pinned panels — is `/feed`, linked from home.

Left out on purpose: the waiting-on-you line, the clog, vitals and keeper lines (the boards and the Flow dialog still show them), and "slowest right now" (it needs a timing read the home does not have). The box posts to `/tell` today; it becomes the `/talk` entry (#7652) when that lands.

The two scans behind the lists are read once per write (`writeStamp`), so a warm home reads no tables for them.
