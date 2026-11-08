# The living home (#8015)

Signed in, `/` is five things and nothing else:

1. **The box** — one line that tells the crew (`POST /tell`, the same action the feed's composer posts to). A phone's share sheet fills it.
2. **The figures** (admins) — the KPI tiles and any alarm, one calm line each. Everyone else gets the live version line.
3. **Now** (site admins) — `check › review › land › live`, each the sum of the `/boards` stages it names (`nowOf` in `src/flow/moving.ts`), each a link. The counts take in every repository, private ones too, so no one else is shown them.
4. **Being built / Just shipped** — three rows each, every row a link to its issue or pull, read for the viewer (a repository they cannot read, and a sealed report, are never named). One live region, `#live-moving`, redrawn from `/live/moving` when a run or a merge moves; it always holds six rows, so nothing below it shifts.
5. **Your apps** — a chip per app and a plus; `#live-chips`, redrawn from `/live/chips`.

The terminal's home carries the same lines (`movingLines` in `src/tui/screens/moving.ts`): Now for a site admin, then being built and just shipped, read for the viewer; its tell is the box.

6. **Pinned panels** — an admin's own pins, in their order, right after the KPIs. With no pin nothing is drawn. With one, home holds an empty `#home-panels` slot (one panel row tall, so nothing shifts) that the refresh script fills from `/live/home/panels` after first paint, keeping Up, Down and Unpin; with no script a link opens the same fragment. The panels sit in a live region (`#home-pins`) that redraws on `board.pins`, the event every pin, unpin and move makes for its owner alone, so a change from a board, the terminal, the API or the MCP shows at once. In the terminal the same list is the palette's Pinned panels (`src/tui/screens/home_pins.ts`): `<`/`>` move, `u` unpins, `enter` opens the board. `/feed` still draws them too.

The feed — the composer, the timeline, what is on you, since you were here — is `/feed`, linked from home.

Left out on purpose: the waiting-on-you line, the clog, vitals and keeper lines (the boards and the Flow dialog still show them), and "slowest right now" (it needs a timing read the home does not have). The box posts to `/tell` today; it becomes the `/talk` entry (#7652) when that lands.

The two scans behind the lists are read once per write (`writeStamp`), so a warm home reads no tables for them.
