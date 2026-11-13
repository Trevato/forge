# Database size (#12010)

The forge knows how big its own database is, and which tables and indexes
make it so. Bloat shows up on /system, not in a profiler.

## Where to see it

- **/system → Database size** (the owner). One sentence stays on first
  view: the file's size and its growth a day, with a badge when either is
  worth a look. Behind the disclosure:
  - Fact rows (`dl`): `forge.db`'s bytes, the WAL's bytes, the free pages
    inside the file (what `VACUUM` would give back), and how much the file
    grows (or shrinks) a day.
  - One table: the ten largest tables with rows and bytes, then the ten
    largest indexes with the table each one serves and bytes.
- **The terminal → System** (a forge admin, or an agent granted
  `telemetry:read`). One line under the largest directories: the file's size
  and its growth a day. `d` opens **Database size**, a scrolled screen with
  the WAL, the free pages, the ten largest tables and the ten largest
  indexes. It reads the same cache as the page.
- **MCP `system` with `{ "kind": "size" }`** (a forge admin, or an agent
  granted `telemetry:read`). It returns the same data as JSON:
  `{ fileBytes, walBytes, growth: { perDay, days, readings }, walk: { at, pageSize, freeBytes, tables, indexes } | null }`.

## How it is measured

Bun's SQLite is built without `dbstat` and without `sqlite_dbpage`, so
`src/system/db_size.ts` reads the file itself. It reads in 4 MiB
asynchronous chunks, so the event loop is never held. For every b-tree page
it records the page's kind, its cells and its children. Then it walks each
b-tree down from its root page in `sqlite_schema`:

- A table's bytes are its interior, leaf and overflow pages times the page
  size.
- A rowid table's rows are its leaf cells.
- A freed page belongs to no tree.

On a seeded database these figures match SQLite's own `dbstat` page for page.

The file is read as of its last checkpoint, so pages still only in the WAL
are not counted. The WAL's bytes are shown beside it. One walk is shared by
/system, the terminal and the MCP tool. The forge walks at most once an
hour, and only when someone opens /system or the terminal's System screen,
or calls the tool. A walk reads the whole file once: on a 4.5 GB database
that is 4.5 GB of reads, at most once an hour, and none in an hour nobody
asks. A walk that fails is logged (`database size walk failed`) and is
tried again an hour later.

## Growth, and when the owner hears

On its two-minute tick, the forge keeps the file's first size reading of
each UTC day in `db_size_day`, and keeps the last 60 days.

Growth a day is the file's size now minus the oldest reading from the last
seven days, divided by the time between them. Growth is not shown until the
readings span 20 hours.

The vitals add a need, linked to /system, when either of these is true:

- `db-size`: the file is past 2 GiB (`0x7fff0000` bytes, the most Bun's
  SQLite maps, its `MAX_MMAP_SIZE`).
- `db-growth`: the file grows faster than 64 MiB a day. At that rate an
  empty database reaches the map's cap in 32 days.
