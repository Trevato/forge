/**
 * The platform's backup lanes, read from their stores (#8811).
 *
 * The forge's own lanes (`primary`, `mirror`) are read by manifest in
 * `bucket.ts`. Every other place backups land — one per CronJob in the
 * `backup` namespace — the platform declares in `FORGE_BACKUP_LANES`, a JSON
 * list of `{ name, endpoint, bucket, prefix, region?, accessKey, secretKey }`
 * kept in the forge's configuration, never in this repository, with keys that
 * can only list. This module only lists: it holds no put and no delete. Each
 * lane is read here into `bucket.ts`'s `LaneRead`, the bucket watch keeps it
 * beside the forge's own, and `judge` says it: red when its store does not
 * answer, when nothing is under its prefix, or past 26 h. Home, vitals, MCP
 * `backups` and the terminal's Resilience screen all read that one verdict.
 *
 * Never a full listing. One delimited listing per folder level, at most
 * `PAGES` pages of 1,000 each, and only the folder whose name sorts last is
 * walked into: backup names carry their date (`2026-11-02T…`), so the last
 * name is the newest. The newest object is the one with the latest
 * LastModified among those read. When a level has more than `PAGES` pages
 * the read is bounded: a fresh object found still proves the lane fresh; a
 * stale one or none does not prove it stale, and the lane says so.
 *
 * Credentials never leave: a lane's place is `host/bucket/prefix`, and an
 * error is one line with the lane's keys struck out (`scrubError`).
 */

import { LATE_MS, isRetired, printable, scrubError, type LaneRead } from "./bucket.ts";
import { isOffBox } from "./off_box.ts";
import { s3Where, type S3Target } from "./store.ts";

/** Pages read at one folder level before the read counts as bounded. */
export const PAGES = 3;
/** Entries asked for per page; S3's own maximum. */
export const PAGE_KEYS = 1_000;
/** Folder levels walked into at most. */
export const DEPTH = 6;
/** How long one lane may take to answer, all its pages together. */
export const LANE_DEADLINE_MS = 10_000;
/** Lanes read from configuration at most. */
export const MAX_LANES = 32;

export interface LaneObject {
  readonly key: string;
  readonly bytes: number;
  /** LastModified, ISO 8601. */
  readonly at: string;
}

/** One delimited page: the objects at this level and the folders under it. */
export interface LanePage {
  readonly objects: readonly LaneObject[];
  readonly folders: readonly string[];
  /** Continue with this, when there is more. */
  readonly next?: string | undefined;
}

/** A store as a lane sees it: one listing page at a time, nothing else. */
export interface Lister {
  /** The store's place, never a key. */
  readonly where: string;
  page(prefix: string, next?: string): Promise<LanePage>;
}

/** A lane as declared: where it lists, never yet read. */
export interface Lane {
  readonly name: string;
  readonly prefix: string;
  readonly lister: Lister;
  /** Struck out of every error this lane says. */
  readonly target?: S3Target | undefined;
}

/** The newest object under `prefix`, walking only the last-named folder at each level; `seen` is how many objects were read. */
export async function newestUnder(
  lister: Lister,
  prefix: string,
): Promise<{ newest: LaneObject | undefined; bounded: boolean; seen: number }> {
  let newest: LaneObject | undefined;
  let bounded = false;
  let seen = 0;
  let at = prefix;
  for (let depth = 0; depth < DEPTH; depth++) {
    let last: string | undefined;
    let next: string | undefined;
    let pages = 0;
    do {
      const page = await lister.page(at, next);
      pages++;
      seen += page.objects.length;
      for (const o of page.objects) if (newest === undefined || Date.parse(o.at) > Date.parse(newest.at)) newest = o;
      for (const f of page.folders) if (last === undefined || f > last) last = f;
      next = page.next;
    } while (next !== undefined && pages < PAGES);
    if (next !== undefined) bounded = true;
    if (last === undefined) break;
    at = last;
  }
  return { newest, bounded, seen };
}

function deadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${Math.round(ms / 1000)} s`)), ms);
  });
  work.catch(() => {});
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** Read one lane into the watch's shape. Never throws: a store that refuses is a read with its reason. */
export async function readObjectLane(lane: Lane, now: number, deadlineMs = LANE_DEADLINE_MS): Promise<LaneRead> {
  const where = lane.prefix === "" ? lane.lister.where : `${lane.lister.where}/${lane.prefix}`;
  const base = { lane: lane.name, where, offBox: isOffBox({ where: lane.lister.where }), readAt: new Date(now).toISOString() };
  const none = { newestAt: null, newestName: null, newestBytes: null, count: 0 };
  let found: Awaited<ReturnType<typeof newestUnder>>;
  try {
    found = await deadline(newestUnder(lane.lister, lane.prefix), deadlineMs);
  } catch (error) {
    // One line whatever the store said: a proxy's refusal ends in a newline.
    return { ...base, ...none, error: printable(scrubError([lane.target], error).replace(/\s+/g, " ").trim()) };
  }
  const o = found.newest;
  const read = o === undefined ? none : { newestAt: o.at, newestName: o.key, newestBytes: o.bytes, count: found.seen };
  // A bounded read proves a lane fresh, never stale or empty: it says what it could not see.
  if (found.bounded && (o === undefined || now - Date.parse(o.at) > LATE_MS))
    return { ...base, ...read, error: `only the first ${PAGES * PAGE_KEYS} entries of a folder were read; name a narrower prefix` };
  return { ...base, ...read };
}

/** A bucket listed one delimited page at a time, one attempt per call. */
export function s3Lister(target: S3Target): Lister {
  const client = new Bun.S3Client({
    endpoint: target.endpoint,
    bucket: target.bucket,
    accessKeyId: target.accessKeyId,
    secretAccessKey: target.secretAccessKey,
    ...(target.region === undefined ? {} : { region: target.region }),
  });
  return {
    where: s3Where(target),
    async page(prefix, next) {
      const page = await client.list({
        prefix,
        delimiter: "/",
        maxKeys: PAGE_KEYS,
        ...(next === undefined ? {} : { continuationToken: next }),
      });
      return {
        objects: (page.contents ?? []).flatMap((c) => {
          const at = c.lastModified === undefined ? NaN : Date.parse(c.lastModified);
          // A key is the store's text: no control byte of it is kept.
          return Number.isFinite(at) ? [{ key: printable(c.key), bytes: c.size ?? 0, at: new Date(at).toISOString() }] : [];
        }),
        folders: (page.commonPrefixes ?? []).map((p) => p.prefix),
        next: page.isTruncated ? page.nextContinuationToken : undefined,
      };
    },
  };
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._:/-]{0,63}$/;
const BUCKET = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

/** The longest `backsUp` or `afterSpinDown` a lane may carry. */
export const LINE_MAX = 200;

/** What a lane says of itself: what it backs up, and who reads it once the platform is gone (or `retired`). */
export interface LaneLine {
  readonly backsUp?: string | undefined;
  readonly afterSpinDown?: string | undefined;
}

/** One optional sentence: a string of at most `LINE_MAX`, control bytes replaced; `false` when it is not one. */
function sentence(v: unknown): string | undefined | false {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || v.length > LINE_MAX) return false;
  const t = printable(v).trim();
  return t === "" ? undefined : t;
}

const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);

/** One declared lane, or why it is refused; the sentence never carries a value but the name. */
function declared(raw: unknown, i: number): { name: string; target: S3Target; prefix: string; line: LaneLine } | { name: string; refused: string } {
  const o = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const given = text(o["name"]);
  const name = given !== undefined && NAME.test(given) ? given : `lane ${i + 1}`;
  if (given === undefined || !NAME.test(given)) return { name, refused: "its name is missing or not 1–64 letters, digits, space . _ : / -" };
  const endpoint = text(o["endpoint"]);
  let url: URL | undefined;
  try {
    url = endpoint === undefined ? undefined : new URL(endpoint);
  } catch {
    url = undefined;
  }
  if (url === undefined || (url.protocol !== "https:" && url.protocol !== "http:") || url.username !== "" || url.password !== "")
    return { name, refused: "its endpoint is not an http(s) URL" };
  const bucket = text(o["bucket"]);
  if (bucket === undefined || !BUCKET.test(bucket)) return { name, refused: "its bucket is missing or not a bucket name" };
  const prefix = o["prefix"] === undefined ? "" : o["prefix"];
  // Control bytes and a leading slash never reach a listing.
  if (typeof prefix !== "string" || prefix.length > 512 || /[\u0000-\u001f\u007f]/.test(prefix) || prefix.startsWith("/"))
    return { name, refused: "its prefix is not a string of at most 512 printable characters" };
  const accessKeyId = text(o["accessKey"]);
  const secretAccessKey = text(o["secretKey"]);
  if (accessKeyId === undefined || secretAccessKey === undefined) return { name, refused: "its accessKey or secretKey is missing" };
  const region = o["region"] === undefined ? undefined : text(o["region"]);
  if (o["region"] !== undefined && (region === undefined || !/^[A-Za-z0-9-]{1,32}$/.test(region)))
    return { name, refused: "its region is not a region name" };
  const backsUp = sentence(o["backsUp"]);
  const afterSpinDown = sentence(o["afterSpinDown"]);
  if (backsUp === false || afterSpinDown === false)
    return { name, refused: `its backsUp or afterSpinDown is not a string of at most ${LINE_MAX} characters` };
  return {
    name,
    prefix,
    line: { backsUp, afterSpinDown },
    target: { endpoint: url.href.replace(/\/$/, ""), bucket, accessKeyId, secretAccessKey, region },
  };
}

export interface Declared {
  readonly lanes: readonly { name: string; target: S3Target; prefix: string; line: LaneLine }[];
  /** Lanes the configuration names but that do not read whole: each a red lane on the screen. */
  readonly refused: readonly { name: string; says: string }[];
}

/** `FORGE_BACKUP_LANES` read at the boundary: every field checked, a bad lane refused by name, never echoed. */
export function parseLanes(raw: string | undefined): Declared {
  if (raw === undefined || raw.trim() === "") return { lanes: [], refused: [] };
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    list = undefined;
  }
  if (!Array.isArray(list))
    return { lanes: [], refused: [{ name: "FORGE_BACKUP_LANES", says: "configuration: not a JSON list of lanes" }] };
  const lanes: Declared["lanes"][number][] = [];
  const refused: { name: string; says: string }[] = [];
  const seen = new Set<string>();
  list.slice(0, MAX_LANES).forEach((raw, i) => {
    const d = declared(raw, i);
    if ("refused" in d) refused.push({ name: d.name, says: `configuration: ${d.refused}` });
    else if (seen.has(d.name)) refused.push({ name: d.name, says: "configuration: a second lane of this name" });
    else {
      seen.add(d.name);
      lanes.push(d);
    }
  });
  if (list.length > MAX_LANES)
    refused.push({ name: "FORGE_BACKUP_LANES", says: `configuration: ${list.length} lanes, only the first ${MAX_LANES} read` });
  return { lanes, refused };
}

/**
 * Every declared lane read at once, a lane the configuration refuses kept as
 * a read with its reason. The bucket watch calls this on each pass.
 */
export async function readDeclaredLanes(
  env: Record<string, string | undefined> = process.env,
  now = Date.now(),
  /** A lister for a bucket; tests hand a fake. */
  listerFor: (target: S3Target) => Lister = s3Lister,
): Promise<LaneRead[]> {
  const { lanes, refused } = parseLanes(env["FORGE_BACKUP_LANES"]);
  const read = await Promise.all(
    lanes.map(async (d): Promise<LaneRead> => {
      const line = { ...(d.line.backsUp === undefined ? {} : { backsUp: d.line.backsUp }), ...(d.line.afterSpinDown === undefined ? {} : { afterSpinDown: d.line.afterSpinDown }) };
      // A retired lane is listed, never read: its store may be gone.
      if (isRetired(d.line.afterSpinDown))
        return {
          lane: d.name,
          where: s3Where(d.target),
          offBox: false,
          newestAt: null,
          newestName: null,
          newestBytes: null,
          count: 0,
          readAt: new Date(now).toISOString(),
          ...line,
        };
      return { ...(await readObjectLane({ name: d.name, prefix: d.prefix, lister: listerFor(d.target), target: d.target }, now)), ...line };
    }),
  );
  return [
    ...read,
    ...refused.map((r) => ({
      lane: r.name,
      where: "FORGE_BACKUP_LANES",
      offBox: false,
      newestAt: null,
      newestName: null,
      newestBytes: null,
      count: 0,
      error: r.says,
      readAt: new Date(now).toISOString(),
    })),
  ];
}
