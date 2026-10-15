/**
 * The family across forges (#425): a child tells its parent how it stands,
 * and the parent never reaches in. A heartbeat is a small signed JSON
 * document carrying the child's name, a time, its version and two counts —
 * open proposals and children of its own — and nothing else: no titles, no
 * names, no data. The parent keeps the last one per child under
 * `<data>/beats/<name>.json`.
 *
 * Signed with the key spawn gave both sides (`beatKey` in the parent's
 * ledger and in the child's `parent.json`): HMAC-SHA256 over the exact body
 * bytes. A name the parent did not make, a bad signature, a stale or
 * replayed time, a malformed body all get the same answer and change
 * nothing: unknown children are ignored.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { App } from "../app.ts";
import { beatKeyOf, listChildren } from "../actions/spawn.ts";
import releases from "../core/releases.json" with { type: "json" };
import { running } from "../kernel/version.ts";

export const SIGNATURE_HEADER = "x-forge-signature";
/** A child reports this often; one silent for three beats reads as quiet. */
export const BEAT_MS = 10 * 60_000;
export const QUIET_MS = 3 * BEAT_MS;
/** A heartbeat's time may differ from the parent's clock by this much. */
const SKEW_MS = 10 * 60_000;
const MAX_BODY = 1024;
export const MAX_CHILDREN = 100;
export const MAX_DEPTH = 4;
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
const COUNT_MAX = 1_000_000;

export interface Beat {
  readonly name: string;
  /** The child's clock, ms since the epoch. */
  readonly at: number;
  readonly version: string;
  readonly openProposals: number;
  readonly children: number;
}

export function sign(key: string, body: string): string {
  return createHmac("sha256", key).update(body).digest("hex");
}

function verified(key: string, body: string, shown: string | null): boolean {
  if (shown === null || !/^[0-9a-f]{64}$/.test(shown)) return false;
  return timingSafeEqual(Buffer.from(sign(key, body)), Buffer.from(shown));
}

const count = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= COUNT_MAX;

/** The beat in `raw`, or undefined when it is not exactly one. */
export function parseBeat(raw: string): Beat | undefined {
  if (raw.length > MAX_BODY) return undefined;
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return undefined;
  const d = doc as Record<string, unknown>;
  const keys = Object.keys(d).sort().join(",");
  if (keys !== "at,children,name,openProposals,version") return undefined;
  const { name, at, version, openProposals, children } = d;
  if (typeof name !== "string" || !NAME.test(name)) return undefined;
  if (typeof at !== "number" || !Number.isSafeInteger(at) || at <= 0) return undefined;
  if (typeof version !== "string" || !VERSION.test(version)) return undefined;
  if (!count(openProposals) || !count(children)) return undefined;
  return { name, at, version, openProposals, children };
}

const beatPath = (app: App, name: string): string =>
  join(app.config.dataDir, "beats", `${name}.json`);

/** What this forge heard, and when (ms), for one child. */
export interface Heard {
  readonly beat: Beat;
  readonly receivedAt: number;
}

async function lastHeard(app: App, name: string): Promise<Heard | undefined> {
  try {
    const doc = JSON.parse(await readFile(beatPath(app, name), "utf8")) as {
      receivedAt?: unknown;
      beat?: unknown;
    };
    const beat = parseBeat(JSON.stringify(doc.beat));
    return beat !== undefined && typeof doc.receivedAt === "number"
      ? { beat, receivedAt: doc.receivedAt }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Take one heartbeat. True when it was kept; false for every refusal, which
 * the caller answers alike so nothing says whether a name is a child.
 */
export function receiveBeat(
  app: App,
  raw: string,
  signature: string | null,
  now = Date.now(),
): Promise<boolean> {
  // One at a time per name, so two identical beats cannot both be kept.
  const name = parseBeat(raw)?.name ?? "";
  const run = (turns.get(name) ?? Promise.resolve()).then(() =>
    takeBeat(app, raw, signature, now),
  );
  const tail = run.then(() => undefined, () => undefined);
  turns.set(name, tail);
  void tail.then(() => {
    if (turns.get(name) === tail) turns.delete(name);
  });
  return run;
}

const turns = new Map<string, Promise<void>>();

async function takeBeat(
  app: App,
  raw: string,
  signature: string | null,
  now: number,
): Promise<boolean> {
  const beat = parseBeat(raw);
  if (beat === undefined) return false;
  const key = await beatKeyOf(app, beat.name);
  if (key === undefined || !verified(key, raw, signature)) return false;
  if (Math.abs(now - beat.at) > SKEW_MS) return false;
  const before = await lastHeard(app, beat.name);
  if (before !== undefined && beat.at <= before.beat.at) return false;
  await mkdir(join(app.config.dataDir, "beats"), { recursive: true });
  const path = beatPath(app, beat.name);
  await writeFile(`${path}.tmp`, JSON.stringify({ receivedAt: now, beat }));
  await rename(`${path}.tmp`, path);
  return true;
}

/** What a child knows of its parent from `parent.json`, when it has all of it. */
async function parentLink(
  app: App,
): Promise<{ name: string; upstream: string; key: string } | undefined> {
  try {
    const doc = (await Bun.file(join(app.config.dataDir, "parent.json")).json()) as Record<string, unknown>;
    const { name, upstream, beatKey } = doc;
    if (typeof name !== "string" || !NAME.test(name)) return undefined;
    if (typeof upstream !== "string" || !/^https?:\/\/[^\s?#]+$/.test(upstream)) return undefined;
    if (typeof beatKey !== "string" || beatKey === "") return undefined;
    return { name, upstream: upstream.replace(/\/+$/, ""), key: beatKey };
  } catch {
    return undefined;
  }
}

/** This forge's standing, as the beat carries it. Counts only. */
export function standing(app: App, name: string, at = Date.now()): Beat {
  const proposals = app.db
    .query<{ n: number }, []>(
      `SELECT COUNT(*) AS n FROM pull JOIN issue ON issue.id = pull.issue_id WHERE issue.state = 'open'`,
    )
    .get();
  return {
    name,
    at,
    version: running().version,
    openProposals: Math.min(proposals?.n ?? 0, COUNT_MAX),
    children: 0,
  };
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
let lastAt = 0;

/** A spawned child's one report to its parent; false when it has no parent or the try failed. Never throws. */
export async function sendBeat(
  app: App,
  fetcher: FetchLike = fetch,
  now = Date.now(),
): Promise<boolean> {
  const link = await parentLink(app);
  if (link === undefined) return false;
  const own = (await listChildren(app)).length;
  // Strictly later than the last one sent, so a quick restart is not a replay.
  lastAt = Math.max(now, lastAt + 1);
  const body = JSON.stringify({
    ...standing(app, link.name, lastAt),
    children: Math.min(own, COUNT_MAX),
  });
  try {
    const res = await fetcher(`${link.upstream}/api/v1/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json", [SIGNATURE_HEADER]: sign(link.key, body) },
      body,
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Report now and then every BEAT_MS; returns the timer to clear. */
export function startHeartbeat(app: App): ReturnType<typeof setInterval> {
  void sendBeat(app);
  return setInterval(() => void sendBeat(app), BEAT_MS);
}

export type Standing = "reporting" | "quiet" | "unheard";

export interface ChildStanding {
  readonly name: string;
  readonly url: string;
  readonly state: Standing;
  /** ms since the epoch the parent last heard, or null. */
  readonly lastSeen: number | null;
  readonly version: string | null;
  /** Releases the child is behind this forge, or null when its version is not one of ours. */
  readonly behind: number | null;
  readonly openProposals: number | null;
  readonly ownChildren: number | null;
}

/** How many releases of this forge are newer than `version`; null when it is not one of them. */
export function releasesBehind(version: string): number | null {
  const i = releases.releases.findIndex((r) => r.version === version);
  return i < 0 ? null : i;
}

/** Each child this forge made, as last heard; bounded, and a silent one is quiet, not broken. */
export async function childStandings(
  app: App,
  now = Date.now(),
): Promise<{ items: ChildStanding[]; more: number }> {
  const all = await listChildren(app);
  const items: ChildStanding[] = [];
  for (const c of all.slice(0, MAX_CHILDREN)) {
    const heard = await lastHeard(app, c.name);
    items.push({
      name: c.name,
      url: c.url,
      state: heard === undefined ? "unheard" : now - heard.receivedAt > QUIET_MS ? "quiet" : "reporting",
      lastSeen: heard?.receivedAt ?? null,
      version: heard?.beat.version ?? null,
      behind: heard === undefined ? null : releasesBehind(heard.beat.version),
      openProposals: heard?.beat.openProposals ?? null,
      ownChildren: heard?.beat.children ?? null,
    });
  }
  return { items, more: Math.max(0, all.length - MAX_CHILDREN) };
}

/** The address of the forge that sent this one, when it was spawned and told. */
export async function parentUpstream(app: App): Promise<string | undefined> {
  return (await parentLink(app))?.upstream;
}
