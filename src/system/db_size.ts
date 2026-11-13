/**
 * How big the forge's database is, and what makes it so (#12010): the
 * file's bytes, the ten largest tables (with their rows) and the ten largest
 * indexes, and how fast the file grows a day, from one reading a UTC day
 * kept for 60 days (`db_size_day`).
 *
 * Bun's SQLite (3.53, embedded) is built without `dbstat` and without
 * `sqlite_dbpage` (`PRAGMA compile_options`, checked on Bun 1.3), and where
 * `dbstat` exists it walks every page on the thread that asks. So the sizes
 * come from the file itself, read in large asynchronous chunks so the event
 * loop is never held: each b-tree page's kind, cells and children
 * (https://www.sqlite.org/fileformat2.html §1.6), then each b-tree walked
 * down from its root page in `sqlite_schema`, so a freed page never counts.
 * A b-tree's bytes are its pages (interior, leaf and overflow) times the page
 * size; a rowid table's rows are its leaf cells, a WITHOUT ROWID table's its
 * cells. The file is as of the last checkpoint: pages still only in the WAL
 * are not in it, and the WAL's own bytes are named beside it.
 *
 * One measurement is shared by /system and the MCP `system` tool, taken at
 * most once an hour, and no request waits on it longer than 0.8 s.
 */

import type { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { join } from "node:path";
import type { Log } from "../kernel/log.ts";

/** Where a failed walk is said: the forge's log (`app.log`). */
type Warn = Pick<Log, "warn">;

/** A table and what it holds: bytes of its b-tree, and its rows. */
export interface TableSize {
  readonly name: string;
  readonly bytes: number;
  readonly rows: number;
}

/** An index, the table it serves, and the bytes of its b-tree. */
export interface IndexSize {
  readonly name: string;
  readonly table: string;
  readonly bytes: number;
}

/** What one walk of the file found. */
export interface DbWalk {
  /** When the walk finished, ISO. */
  readonly at: string;
  readonly pageSize: number;
  /** Bytes on the freelist: room `VACUUM` would give back. */
  readonly freeBytes: number;
  /** The `TOP` largest tables, largest first. */
  readonly tables: readonly TableSize[];
  /** The `TOP` largest indexes, largest first. */
  readonly indexes: readonly IndexSize[];
}

/** Growth per day, measured from the daily readings. */
export interface DbGrowth {
  /** Bytes a day, averaged over `days`; null until the readings span a day. */
  readonly perDay: number | null;
  /** The span the average is over, in days (one decimal). */
  readonly days: number;
  /** Every reading kept, oldest first: one a UTC day, at most `KEEP_DAYS`. */
  readonly readings: readonly { readonly day: string; readonly bytes: number }[];
}

/** The database's size now, as /system and the MCP tool give it. */
export interface DbSize {
  /** Bytes of `forge.db` now. */
  readonly fileBytes: number;
  /** Bytes of `forge.db-wal` now (0 when absent). */
  readonly walBytes: number;
  readonly growth: DbGrowth;
  /** The last walk of the file, or null while the first runs. */
  readonly walk: DbWalk | null;
}

/** How many tables and indexes are named. */
export const TOP = 10;
/** Days of readings kept. */
export const KEEP_DAYS = 60;
/** The window growth is averaged over, at most. */
export const GROWTH_WINDOW_DAYS = 7;
/**
 * Bun's SQLite maps at most 0x7fff0000 bytes (`MAX_MMAP_SIZE` in
 * `PRAGMA compile_options`): 2 GiB less 64 KiB. Past it, reads leave the map
 * for read() calls (`src/kernel/db.ts`), so a file this size is said.
 */
export const DB_FILE_CAP = 0x7fff_0000;
/**
 * Growth worth saying: 64 MiB a day takes an empty database to the map's cap
 * in 32 days, faster than any month of the forge's own use has needed.
 */
export const DB_GROWTH_MAX = 64 * 1024 * 1024;

const DAY_MS = 86_400_000;
/** Growth is not averaged over less than this, so one busy hour is not a day. */
const MIN_SPAN_MS = 20 * 3_600_000;

/** The database file under `dataDir`. */
export const dbFile = (dataDir: string): string => join(dataDir, "forge.db");

/** Bytes of a file, or 0 when it is absent. */
export function fileBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------- the walk

/** A SQLite varint at `at`: its value and the bytes it took (fileformat2 §1.6, "varint"). */
function varint(b: Uint8Array, at: number, end: number): [number, number] {
  let v = 0;
  for (let i = 0; i < 8; i++) {
    if (at + i >= end) return [v, i];
    const byte = b[at + i]!;
    v = v * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return [v, i + 1];
  }
  if (at + 8 >= end) return [v, 8];
  return [v * 256 + b[at + 8]!, 9];
}

/**
 * Overflow pages a cell's payload of `p` bytes spills into, for usable page
 * size `u` (fileformat2 §1.6, "Cell payload overflow pages"): X is the most
 * kept on the page (u-35 on a table leaf, ((u-12)·64/255)-23 on an index),
 * M = ((u-12)·32/255)-23 the least, K = M + ((P-M) mod (u-4)); the page keeps
 * K when K ≤ X, else M, and the rest fills pages of u-4 bytes each.
 */
export function overflowPages(p: number, u: number, tableLeaf: boolean): number {
  const x = tableLeaf ? u - 35 : Math.floor(((u - 12) * 64) / 255) - 23;
  if (p <= x) return 0;
  const m = Math.floor(((u - 12) * 32) / 255) - 23;
  const k = m + ((p - m) % (u - 4));
  const local = k <= x ? k : m;
  return Math.ceil((p - local) / (u - 4));
}

/** What the walk keeps of every page: b-tree kind (0 for none), cells, overflow pages, children. */
interface Pages {
  readonly kind: Uint8Array;
  readonly cells: Uint32Array;
  readonly overflow: Uint32Array;
  readonly children: Map<number, number[]>;
}

/**
 * Reads page `n` (at `base` in `buf`) into `pages` when it is a well-formed
 * b-tree page; anything else (overflow, freelist, a torn page) stays kind 0.
 */
function readPage(buf: Uint8Array, base: number, n: number, pageSize: number, usable: number, pages: Pages, count: number): void {
  const h = base + (n === 1 ? 100 : 0);
  const kind = buf[h]!;
  if (kind !== 2 && kind !== 5 && kind !== 10 && kind !== 13) return;
  const interior = kind === 2 || kind === 5;
  const cellCount = (buf[h + 3]! << 8) | buf[h + 4]!;
  const ptrs = h + (interior ? 12 : 8);
  const end = base + usable;
  if (ptrs + 2 * cellCount > end) return;
  const kids: number[] = [];
  let spill = 0;
  for (let i = 0; i < cellCount; i++) {
    const off = (buf[ptrs + 2 * i]! << 8) | buf[ptrs + 2 * i + 1]!;
    let at = base + off;
    if (off < ptrs + 2 * cellCount - base || at >= end) return;
    if (interior) {
      if (at + 4 > end) return;
      const child = ((buf[at]! << 24) >>> 0) + (buf[at + 1]! << 16) + (buf[at + 2]! << 8) + buf[at + 3]!;
      if (child < 1 || child > count) return;
      kids.push(child);
      at += 4;
    }
    if (kind === 5) continue; // a table's interior cell is a key, no payload
    const [payload] = varint(buf, at, end);
    spill += overflowPages(payload, usable, kind === 13);
  }
  if (interior) {
    const right = ((buf[h + 8]! << 24) >>> 0) + (buf[h + 9]! << 16) + (buf[h + 10]! << 8) + buf[h + 11]!;
    if (right < 1 || right > count) return;
    kids.push(right);
    pages.children.set(n, kids);
  }
  pages.kind[n] = kind;
  pages.cells[n] = cellCount;
  pages.overflow[n] = spill;
}

/** One b-tree to size: its name, its table, whether it is an index, and its root page. */
export interface Root {
  readonly name: string;
  readonly table: string;
  readonly index: boolean;
  readonly root: number;
}

/** What one b-tree holds: pages (with overflow) and the cells that are rows or entries. */
export interface TreeSize extends Root {
  readonly pages: number;
  readonly rows: number;
}

/** The pages read per chunk: 1,024 pages of 4 KiB is 4 MiB a read. */
const CHUNK_PAGES = 1024;

/**
 * Sizes each b-tree in the file at `path` by walking it from its root. The
 * file is read in chunks of `CHUNK_PAGES`, each read awaited, so the loop is
 * free between them; the parse of a chunk is a few hundred microseconds.
 */
export async function walkFile(path: string, roots: readonly Root[]): Promise<{ pageSize: number; freePages: number; trees: TreeSize[] }> {
  const file = Bun.file(path);
  const head = new Uint8Array(await file.slice(0, 100).arrayBuffer());
  if (head.length < 100 || new TextDecoder().decode(head.subarray(0, 15)) !== "SQLite format 3")
    throw new Error(`${path} is not a SQLite database`);
  const raw = (head[16]! << 8) | head[17]!;
  const pageSize = raw === 1 ? 65536 : raw;
  if (pageSize < 512 || (pageSize & (pageSize - 1)) !== 0) throw new Error(`${path} has page size ${raw}`);
  const usable = pageSize - head[20]!;
  const freePages = ((head[36]! << 24) >>> 0) + (head[37]! << 16) + (head[38]! << 8) + head[39]!;
  const count = Math.floor(file.size / pageSize);
  const pages: Pages = {
    kind: new Uint8Array(count + 1),
    cells: new Uint32Array(count + 1),
    overflow: new Uint32Array(count + 1),
    children: new Map(),
  };
  for (let first = 1; first <= count; first += CHUNK_PAGES) {
    const last = Math.min(count, first + CHUNK_PAGES - 1);
    const buf = new Uint8Array(await file.slice((first - 1) * pageSize, last * pageSize).arrayBuffer());
    for (let n = first; n <= last && (n - first + 1) * pageSize <= buf.length; n++)
      readPage(buf, (n - first) * pageSize, n, pageSize, usable, pages, count);
  }
  // Top down from each root: a page is counted once, by the first tree that reaches it.
  const seen = new Uint8Array(count + 1);
  const trees: TreeSize[] = [];
  for (const r of roots) {
    let total = 0;
    let rows = 0;
    const stack = r.root >= 1 && r.root <= count ? [r.root] : [];
    while (stack.length > 0) {
      const n = stack.pop()!;
      if (seen[n] === 1 || pages.kind[n] === 0) continue;
      seen[n] = 1;
      const kind = pages.kind[n]!;
      total += 1 + pages.overflow[n]!;
      // Rows: a rowid table's leaf cells; an index (or WITHOUT ROWID table) holds an entry in
      // every cell.
      if (kind === 13 || kind === 10 || kind === 2) rows += pages.cells[n]!;
      for (const c of pages.children.get(n) ?? []) stack.push(c);
    }
    trees.push({ ...r, pages: total, rows });
  }
  return { pageSize, freePages, trees };
}

/** Every b-tree the schema names, with `sqlite_schema` itself on page 1. */
export function rootsOf(db: Database): Root[] {
  const rows = db
    .query<{ type: string; name: string; tbl_name: string; rootpage: number }, []>(
      "SELECT type, name, tbl_name, rootpage FROM sqlite_schema WHERE type IN ('table', 'index') AND rootpage > 0",
    )
    .all();
  return [
    { name: "sqlite_schema", table: "sqlite_schema", index: false, root: 1 },
    ...rows.map((r) => ({ name: r.name, table: r.tbl_name, index: r.type === "index", root: r.rootpage })),
  ];
}

/** The `n` largest, largest first; equal sizes by name, so the order is stable. */
export function largestFirst<T extends { name: string; bytes: number }>(rows: readonly T[], n = TOP): T[] {
  return [...rows].sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name)).slice(0, n);
}

/** Walks the database file under `dataDir` and keeps the ten largest tables and indexes. */
export async function measureDbWalk(db: Database, dataDir: string, clock: () => number = Date.now): Promise<DbWalk> {
  const { pageSize, freePages, trees } = await walkFile(dbFile(dataDir), rootsOf(db));
  const tables = trees
    .filter((t) => !t.index)
    .map((t) => ({ name: t.name, bytes: t.pages * pageSize, rows: t.rows }));
  const indexes = trees
    .filter((t) => t.index)
    .map((t) => ({ name: t.name, table: t.table, bytes: t.pages * pageSize }));
  return {
    at: new Date(clock()).toISOString(),
    pageSize,
    freeBytes: freePages * pageSize,
    tables: largestFirst(tables),
    indexes: largestFirst(indexes),
  };
}

// ---------------------------------------------------------------- growth

/** The UTC day of an instant. */
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * Keeps the first reading of each UTC day and drops those older than
 * `KEEP_DAYS`. Called on the forge's two-minute tick; a day already read
 * costs one ignored insert.
 */
export function noteDbSize(db: Database, dataDir: string, now: number = Date.now()): void {
  const bytes = fileBytes(dbFile(dataDir));
  if (bytes === 0) return;
  db.query("INSERT OR IGNORE INTO db_size_day (day, at, bytes) VALUES (?, ?, ?)").run(dayOf(now), new Date(now).toISOString(), bytes);
  db.query("DELETE FROM db_size_day WHERE day < ?").run(dayOf(now - KEEP_DAYS * DAY_MS));
}

/**
 * Growth a day: the file now against the oldest reading inside the last
 * `GROWTH_WINDOW_DAYS`, over the time between them; null while that is
 * under 20 hours.
 */
export function dbGrowth(db: Database, bytesNow: number, now: number = Date.now()): DbGrowth {
  const rows = db
    .query<{ day: string; at: string; bytes: number }, []>("SELECT day, at, bytes FROM db_size_day ORDER BY day")
    .all();
  const readings = rows.map((r) => ({ day: r.day, bytes: r.bytes }));
  const from = rows.find((r) => Date.parse(r.at) >= now - GROWTH_WINDOW_DAYS * DAY_MS);
  const span = from === undefined ? 0 : now - Date.parse(from.at);
  if (from === undefined || span < MIN_SPAN_MS) return { perDay: null, days: 0, readings };
  return {
    perDay: Math.round((bytesNow - from.bytes) / (span / DAY_MS)),
    days: Math.round((span / DAY_MS) * 10) / 10,
    readings,
  };
}

/** Bytes said short: GiB with one decimal from 1 GiB, else whole MiB. */
const sizeSaid = (n: number): string => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GiB` : `${Math.round(n / 1024 ** 2)} MiB`);

/** Rows said short: 812, 41k, 3.2M. */
const rowsSaid = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);

/** How many tables the alarm names. */
export const NEED_TABLES = 5;

/**
 * What fills the file, from a walk (#12051): its five largest tables, their
 * bytes and rows, and the freelist, as of the walk's own time, since the walk
 * may be up to an hour old.
 */
export function walkSaid(walk: DbWalk): string {
  const tables = walk.tables
    .slice(0, NEED_TABLES)
    .map((t) => `${t.name} ${sizeSaid(t.bytes)} (${rowsSaid(t.rows)} rows)`)
    .join(", ");
  return `as of ${walk.at.slice(11, 16)}Z its largest tables are ${tables}; ${sizeSaid(walk.freeBytes)} free.`;
}

/**
 * One sentence for the vitals when the file is past the map's cap or grows
 * too fast. With a walk it names what fills the file, so the alarm (and the
 * Sentinel issue that quotes it) carries its own evidence; without one it
 * points at /system.
 */
export function dbSizeNeed(
  fileBytes: number,
  growth: Pick<DbGrowth, "perDay" | "days">,
  walk: DbWalk | null = null,
): { cause: "db-size" | "db-growth"; sentence: string } | undefined {
  const gib = (n: number): string => (n / 1024 ** 3).toFixed(1);
  const mib = (n: number): string => String(Math.round(n / 1024 ** 2));
  const tail = walk === null || walk.tables.length === 0 ? "; /system names its largest tables." : `: ${walkSaid(walk)}`;
  if (fileBytes > DB_FILE_CAP)
    return {
      cause: "db-size",
      sentence: `The database is ${gib(fileBytes)} GiB, past the 2 GiB Bun maps${tail}`,
    };
  if (growth.perDay !== null && growth.perDay > DB_GROWTH_MAX)
    return {
      cause: "db-growth",
      sentence: `The database grows ${mib(growth.perDay)} MiB a day over ${growth.days} days, past the ${mib(DB_GROWTH_MAX)} MiB a day worth a look${tail}`,
    };
  return undefined;
}

// ---------------------------------------------------------------- the shared reading

const FRESH_MS = 3_600_000;
const WAIT_MS = 800;

/** The last walk, shared by /system and the MCP `system` tool; one per process, gone on restart. */
export function dbSizeCache(
  walk: (db: Database, dataDir: string) => Promise<DbWalk> = (db, d) => measureDbWalk(db, d),
  clock: () => number = Date.now,
) {
  let last: { at: number; dataDir: string; value: DbWalk } | null = null;
  // A walk that failed waits an hour too, so a broken file costs one try an hour.
  let triedAt: { at: number; dataDir: string } | null = null;
  let pending: Promise<DbWalk | null> | null = null;
  const due = (dataDir: string): boolean =>
    pending === null &&
    (last === null || last.dataDir !== dataDir || clock() - last.at > FRESH_MS) &&
    (triedAt === null || triedAt.dataDir !== dataDir || clock() - triedAt.at > FRESH_MS);
  const refresh = (db: Database, dataDir: string, log?: Warn): Promise<DbWalk | null> => {
    triedAt = { at: clock(), dataDir };
    pending = walk(db, dataDir)
      .then((value) => {
        last = { at: clock(), dataDir, value };
        return value;
      })
      .catch((e: unknown) => {
        // Said, not swallowed: a broken walk shows in the log, and the page keeps the last one.
        log?.warn("database size walk failed", { dataDir, error: e instanceof Error ? e.message : String(e) });
        return null;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };
  const current = (dataDir: string): DbWalk | null => (last?.dataDir === dataDir ? last.value : null);
  const now = (db: Database, dataDir: string, w: DbWalk | null): DbSize => {
    const file = fileBytes(dbFile(dataDir));
    return { fileBytes: file, walBytes: fileBytes(`${dbFile(dataDir)}-wal`), growth: dbGrowth(db, file, clock()), walk: w };
  };
  return {
    /**
     * The last walk alone, for the vitals' db-size alarm (#12051); a new walk
     * starts behind it when that is an hour old, never waited on.
     */
    last(db: Database, dataDir: string, log?: Warn): DbWalk | null {
      if (due(dataDir)) void refresh(db, dataDir, log);
      return current(dataDir);
    },
    /** The size now with the last walk; a new walk starts behind it when that is an hour old. */
    peek(db: Database, dataDir: string, log?: Warn): DbSize {
      if (due(dataDir)) void refresh(db, dataDir, log);
      return now(db, dataDir, current(dataDir));
    },
    /** The size now with a walk under an hour old if one ends within `waitMs`, else the last. */
    async read(db: Database, dataDir: string, waitMs = WAIT_MS, log?: Warn): Promise<DbSize> {
      const running = due(dataDir) ? refresh(db, dataDir, log) : pending;
      if (running === null) return now(db, dataDir, current(dataDir));
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const timer = new Promise<null>((r) => {
        deadline = setTimeout(() => r(null), waitMs);
      });
      try {
        return now(db, dataDir, (await Promise.race([running, timer])) ?? current(dataDir));
      } finally {
        clearTimeout(deadline);
      }
    },
  };
}

export const dbSize = dbSizeCache();
