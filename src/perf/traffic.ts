/**
 * Who is using the forge's answering time, by the minute: the performance
 * record's per-class totals (`record.ts`). A route's samples are thinned past
 * `MAX_SAMPLES` and scanning them costs a walk, so these are counted as each
 * request is added: exact under a flood, and cheap enough for home to read.
 *
 * Fifteen buckets: this minute and the 14 before. Bounded: each bucket keeps at
 * most `MAX_KEYS` repositories, user-agent families and prefixes, and whatever
 * comes after falls under `OTHER_KEY`, so the tables can say how much they
 * could not name. Memory only, never written anywhere.
 *
 * An address is never kept. Its /16 (IPv4) or /32 (IPv6) is, and the count of
 * distinct addresses is a HyperLogLog over a hash salted once per process: an
 * estimate within about 3%, from which no address can be read back.
 */

import { addressBytes } from "../kernel/cidr.ts";

export const TRAFFIC_MINUTES = 15;
export const MAX_KEYS = 512;
/** Where a name goes once its minute's table is full. */
export const OTHER_KEY = "(others)";
/** Below this many requests a class is too few to call a problem, whatever its share. */
export const ATTENTION_REQUESTS = 30;

const MINUTE_MS = 60_000;
const SKETCH_BITS = 10;
const SKETCH_SIZE = 1 << SKETCH_BITS;
const SALT = crypto.getRandomValues(new Uint32Array(1))[0]!;
const MAX_REPO = 120;

export const TRAFFIC_CLASSES = ["people", "crawlers", "deep", "other"] as const;
export type TrafficClass = (typeof TRAFFIC_CLASSES)[number];

export interface ClassTotals {
  readonly requests: number;
  /** Summed time to answer, ms. */
  readonly ms: number;
  /** Answered 429. */
  readonly refused: number;
}

/** Who sent one request, as the server knows it; nothing here outlives the call but its prefix and hash. */
export interface TrafficWho {
  readonly address: string;
  readonly family: string;
  readonly repo: string | null;
}

export interface TrafficMinute {
  /** Start of the minute, ms since the epoch. */
  readonly at: number;
  readonly classes: Readonly<Record<TrafficClass, ClassTotals>>;
}

/** The figures home reads on every render: no table is merged for them. */
export interface TrafficTotals {
  /** Where the window starts: the start of the oldest of the 15 minutes. */
  readonly since: number;
  readonly requests: number;
  readonly ms: number;
  readonly refused: number;
  readonly classes: Readonly<Record<TrafficClass, ClassTotals>>;
  /** Oldest first, always 15 of them. */
  readonly minutes: readonly TrafficMinute[];
  /** Distinct client addresses, estimated. */
  readonly addresses: number;
}

export interface TopRow {
  readonly key: string;
  readonly requests: number;
  readonly ms: number;
  /** Of `requests`, how many no one was signed in behind. */
  readonly anonymous: number;
}

export interface TrafficTops {
  readonly repos: readonly TopRow[];
  readonly families: readonly TopRow[];
  readonly prefixes: readonly TopRow[];
}

/** The class a request belongs to: one answer, for the ledger and for a scan of the samples. */
export function classOf(s: {
  readonly signedIn: boolean;
  readonly crawler?: boolean;
  readonly deepStranger?: boolean;
}): TrafficClass {
  if (s.signedIn) return "people";
  if (s.crawler === true) return "crawlers";
  if (s.deepStranger === true) return "deep";
  return "other";
}

/** `203.0.113.9` is `203.0.0.0/16`, `2001:db8:1::2` is `2001:db8::/32`; never the address itself. */
export function prefixOf(bytes: Uint8Array): string {
  if (bytes.length === 4) return `${bytes[0]}.${bytes[1]}.0.0/16`;
  const word = (i: number): string =>
    ((bytes[i]! << 8) | bytes[i + 1]!).toString(16);
  return `${word(0)}:${word(2)}::/32`;
}

const REPO_PATTERN = /^(?:\/origins\/:[^/]+\/r)?\/:owner\/:name(?:\/|$)/;
const REPO_PATH = /^(?:\/origins\/[^/]+\/r)?\/([^/]+\/[^/]+)/;

/** The `owner/name` a route pattern and path read, null when the route is not a repository's. */
export function repoOf(pattern: string, pathname: string): string | null {
  if (!REPO_PATTERN.test(pattern)) return null;
  return REPO_PATH.exec(pathname)?.[1]?.slice(0, MAX_REPO) ?? null;
}

interface Row {
  requests: number;
  ms: number;
  anonymous: number;
}
interface Totals {
  requests: number;
  ms: number;
  refused: number;
}
interface Bucket {
  minute: number;
  readonly classes: Record<TrafficClass, Totals>;
  readonly repos: Map<string, Row>;
  readonly families: Map<string, Row>;
  readonly prefixes: Map<string, Row>;
  /** One register per hash bucket; allocated with the first address. */
  sketch: Uint8Array | null;
}

const noTotals = (): Record<TrafficClass, Totals> => ({
  people: { requests: 0, ms: 0, refused: 0 },
  crawlers: { requests: 0, ms: 0, refused: 0 },
  deep: { requests: 0, ms: 0, refused: 0 },
  other: { requests: 0, ms: 0, refused: 0 },
});

function bump(
  table: Map<string, Row>,
  key: string,
  ms: number,
  anonymous: boolean,
): void {
  const name = table.has(key) || table.size < MAX_KEYS - 1 ? key : OTHER_KEY;
  let row = table.get(name);
  if (row === undefined) {
    row = { requests: 0, ms: 0, anonymous: 0 };
    table.set(name, row);
  }
  row.requests++;
  row.ms += ms;
  if (anonymous) row.anonymous++;
}

function sketchAdd(sketch: Uint8Array, bytes: Uint8Array): void {
  const hash = Number(Bun.hash.xxHash32(bytes, SALT)) >>> 0;
  const index = hash >>> (32 - SKETCH_BITS);
  const rank = Math.clz32((hash << SKETCH_BITS) >>> 0) + 1;
  if (rank > sketch[index]!) sketch[index] = rank;
}

/** HyperLogLog's estimate, with linear counting while registers stay empty: small counts come out exact or nearly. */
export function sketchCount(sketch: Uint8Array): number {
  let sum = 0;
  let zeros = 0;
  for (const r of sketch) {
    sum += 2 ** -r;
    if (r === 0) zeros++;
  }
  const m = sketch.length;
  const raw = ((0.7213 / (1 + 1.079 / m)) * m * m) / sum;
  return Math.round(
    raw <= 2.5 * m && zeros > 0 ? m * Math.log(m / zeros) : raw,
  );
}

export interface TrafficLedger {
  note(
    at: number,
    ms: number,
    cls: TrafficClass,
    refused: boolean,
    who?: TrafficWho,
  ): void;
  totals(now: number): TrafficTotals;
  tops(now: number, limit?: number): TrafficTops;
}

export function createTrafficLedger(): TrafficLedger {
  const buckets = new Map<number, Bucket>();
  const slot = (minute: number): Bucket | undefined => {
    const index = minute % TRAFFIC_MINUTES;
    let bucket = buckets.get(index);
    if (bucket !== undefined && bucket.minute > minute) return undefined;
    if (bucket === undefined || bucket.minute < minute) {
      bucket = {
        minute,
        classes: noTotals(),
        repos: new Map(),
        families: new Map(),
        prefixes: new Map(),
        sketch: null,
      };
      buckets.set(index, bucket);
    }
    return bucket;
  };
  const inWindow = (now: number): Bucket[] => {
    const newest = Math.floor(now / MINUTE_MS);
    return [...buckets.values()].filter(
      (b) => b.minute <= newest && b.minute > newest - TRAFFIC_MINUTES,
    );
  };
  return {
    note(at, ms, cls, refused, who) {
      const bucket = slot(Math.floor(at / MINUTE_MS));
      if (bucket === undefined) return;
      const totals = bucket.classes[cls];
      totals.requests++;
      totals.ms += ms;
      if (refused) totals.refused++;
      if (who === undefined) return;
      const anonymous = cls !== "people";
      bump(bucket.families, who.family, ms, anonymous);
      if (who.repo !== null) bump(bucket.repos, who.repo, ms, anonymous);
      const bytes = addressBytes(who.address);
      if (bytes === undefined) {
        bump(bucket.prefixes, "unknown", ms, anonymous);
        return;
      }
      bump(bucket.prefixes, prefixOf(bytes), ms, anonymous);
      bucket.sketch ??= new Uint8Array(SKETCH_SIZE);
      sketchAdd(bucket.sketch, bytes);
    },
    totals(now) {
      const newest = Math.floor(now / MINUTE_MS);
      const held = new Map(inWindow(now).map((b) => [b.minute, b]));
      const sum = noTotals();
      const merged = new Uint8Array(SKETCH_SIZE);
      const minutes: TrafficMinute[] = [];
      for (
        let minute = newest - TRAFFIC_MINUTES + 1;
        minute <= newest;
        minute++
      ) {
        const bucket = held.get(minute);
        const classes = bucket?.classes ?? noTotals();
        minutes.push({ at: minute * MINUTE_MS, classes });
        for (const c of TRAFFIC_CLASSES) {
          sum[c].requests += classes[c].requests;
          sum[c].ms += classes[c].ms;
          sum[c].refused += classes[c].refused;
        }
        const sketch = bucket?.sketch;
        if (sketch)
          for (let i = 0; i < SKETCH_SIZE; i++)
            if (sketch[i]! > merged[i]!) merged[i] = sketch[i]!;
      }
      const all = TRAFFIC_CLASSES.map((c) => sum[c]);
      return {
        since: minutes[0]!.at,
        requests: all.reduce((n, c) => n + c.requests, 0),
        ms: all.reduce((n, c) => n + c.ms, 0),
        refused: all.reduce((n, c) => n + c.refused, 0),
        classes: sum,
        minutes,
        addresses: sketchCount(merged),
      };
    },
    tops(now, limit = 10) {
      const held = inWindow(now);
      const top = (read: (b: Bucket) => Map<string, Row>): TopRow[] => {
        const merged = new Map<string, Row>();
        for (const bucket of held)
          for (const [key, row] of read(bucket)) {
            const seen = merged.get(key);
            if (seen === undefined) merged.set(key, { ...row });
            else {
              seen.requests += row.requests;
              seen.ms += row.ms;
              seen.anonymous += row.anonymous;
            }
          }
        return [...merged]
          .map(([key, row]) => ({ key, ...row }))
          .sort(
            (a, b) =>
              b.ms - a.ms ||
              b.requests - a.requests ||
              a.key.localeCompare(b.key),
          )
          .slice(0, limit);
      };
      return {
        repos: top((b) => b.repos),
        families: top((b) => b.families),
        prefixes: top((b) => b.prefixes),
      };
    },
  };
}
