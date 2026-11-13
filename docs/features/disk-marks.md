# Disk marks and the largest directories (#11800)

The owner hears about the disk that holds the forge's data well before it
fills, and can see what fills it.

## The marks

The forge's vitals (`src/kernel/vitals.ts`) read the disk under the forge's
data. Past 70% used they say "Disk under the forge's data is N% used, past
the 70% mark."; past 80% the same sentence names the 80% mark. Further up,
the free-space floor and "disk nearly full" take over, as before.

The pager (`src/crew/incidents.ts`) sends each mark to the owner's phone once,
when the disk first passes it. Each mark is one rung: 70%, 80%, the floor,
nearly full. When the disk climbs to a higher rung, the lower rungs still
count as open. They are not paged again, and they do not recover until the
disk drops back under them. A disk that goes from 72% to 85% therefore pages
twice (70%, then 80%). It does not page again on the way down until it
crosses back under 70%.

The marks cover the forge's own data disk only. A machine the forge uses that
does not hold its data is not measured here.

## The largest directories

Each directory directly under the forge's data is sized as `du -x` would size
it: blocks allocated on disk, symlinks not followed, other volumes not
entered. The five largest are shown, largest first. The walk never blocks a
request. A reading is at most a minute old, and a new one starts in the
background when it is older.

Who: a forge admin, or an agent granted `telemetry:read`. Everyone else sees
nothing.

- **/system**: the "Largest under the forge's data" section, below "Disks
  and network", with when it was measured. While the first reading runs, it
  says "Being measured; reload in a moment".
- **The terminal**: `:` → "System". The same five sit below the
  telemetry history, with "measured … ago".
- **MCP**: the `system` tool returns `largestDirs` as
  `{ at, dirs: [{ name, bytes }] }`. It is `null` while the first reading
  runs. The tool waits at most 0.8 s for a new reading, then answers with the
  last one.
