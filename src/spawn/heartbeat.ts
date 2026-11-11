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
import { spentTodayEverywhere } from "../crew/autonomy.ts";
import { beatKeyOf, listChildren } from "../actions/spawn.ts";
import { shippedReleases } from "../release/shipped.ts";
import { forgeLinkOf, forgeTipOf, FOLLOW_MODES, type FollowMode, type ForgeLink } from "./chain.ts";
import { isParentLocal } from "./beat-door.ts";
import { refreshFunding } from "./funding.ts";
import { upstreamState } from "./upstream.ts";
import { progress } from "../core/next-steps.ts";
import { running } from "../kernel/version.ts";
import { forgeCeiling } from "../flow/ceiling.ts";
import { during } from "../perf/jobs.ts";

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
const ISO_TIME = /^\d{4}-\d\d-\d\dT[\d:.]{5,12}Z$/;
const COUNT_MAX = 1_000_000;

export interface Beat {
  readonly name: string;
  /** The child's clock, ms since the epoch. */
  readonly at: number;
  readonly version: string;
  readonly openProposals: number;
  readonly children: number;
  /** The tip of the child's own forge code; absent from an older child, null when it carries none. */
  readonly forgeTip?: string | null;
  /** When the child cut its upstream link; null while it follows. */
  readonly severedAt?: string | null;
  /** How the child follows its parent's code (`parent.json`); absent from an older child. */
  readonly mode?: FollowMode;
  /** Commits behind the parent's code (`upstream.json`); null when unknown, absent from an older child. */
  readonly upstreamBehind?: number | null;
  /** True while a converge issue is open on the child; absent from an older child. */
  readonly conflict?: boolean;
  /** Dollars the child's crew spent since 00:00 UTC; absent from an older child or when it sent a bad value. */
  readonly spendTodayUsd?: number;
  /** The child's forge cap in dollars (the daily ceiling that pauses its crew), null when it has none; absent when unsaid or bad. */
  readonly ceilingUsd?: number | null;
  /** Whether its person has claimed it; absent from an older child or when the value was bad. */
  readonly claimed?: boolean;
  /** Whether it has an everyday account (or chose to go without); absent likewise. */
  readonly everyday?: boolean;
  /** When its person last told the crew something; null before the first, absent likewise. */
  readonly lastTellAt?: string | null;
}

const OPTIONAL = new Set([
  "forgeTip", "severedAt", "mode", "upstreamBehind", "conflict", "spendTodayUsd", "ceilingUsd", "claimed", "everyday", "lastTellAt",
]);
const USD_MAX = 1_000_000;

/** Dollars: a finite number from `min` to a million; anything else is not a sum of money. */
const dollars = (v: unknown, min: number): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= USD_MAX;

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
  const keys = Object.keys(d)
    .filter((k) => !OPTIONAL.has(k))
    .sort()
    .join(",");
  if (keys !== "at,children,name,openProposals,version") return undefined;
  const { name, at, version, openProposals, children, forgeTip, severedAt, mode, upstreamBehind, conflict } = d;
  const tipOk = forgeTip === undefined || forgeTip === null || (typeof forgeTip === "string" && /^[0-9a-f]{40,64}$/.test(forgeTip));
  const sevOk =
    severedAt === undefined ||
    severedAt === null ||
    (typeof severedAt === "string" && severedAt.length <= 40 && !Number.isNaN(Date.parse(severedAt)));
  if (!tipOk || !sevOk) return undefined;
  if (mode !== undefined && !(typeof mode === "string" && (FOLLOW_MODES as readonly string[]).includes(mode))) return undefined;
  if (upstreamBehind !== undefined && upstreamBehind !== null && !count(upstreamBehind)) return undefined;
  if (conflict !== undefined && typeof conflict !== "boolean") return undefined;
  // The person's first steps are only a hint: a bad value drops the field, never the beat.
  const claimed = d["claimed"];
  const everyday = d["everyday"];
  const told = d["lastTellAt"];
  const claimedOk = typeof claimed === "boolean";
  const everydayOk = typeof everyday === "boolean";
  // Strict ISO: it is printed into the parent admin's terminal, so nothing but digits and punctuation.
  const toldOk =
    told === null || (typeof told === "string" && ISO_TIME.test(told) && !Number.isNaN(Date.parse(told)));
  if (typeof name !== "string" || !NAME.test(name)) return undefined;
  if (typeof at !== "number" || !Number.isSafeInteger(at) || at <= 0) return undefined;
  if (typeof version !== "string" || !VERSION.test(version)) return undefined;
  if (!count(openProposals) || !count(children)) return undefined;
  // A bad sum drops the field, not the beat.
  const spend = dollars(d["spendTodayUsd"], 0) ? d["spendTodayUsd"] : undefined;
  const ceil = d["ceilingUsd"] === null ? null : dollars(d["ceilingUsd"], 0.01) ? d["ceilingUsd"] : undefined;
  return {
    name,
    at,
    version,
    openProposals,
    children,
    ...(spend === undefined ? {} : { spendTodayUsd: spend }),
    ...(ceil === undefined ? {} : { ceilingUsd: ceil }),
    ...(forgeTip === undefined ? {} : { forgeTip: forgeTip as string | null }),
    ...(severedAt === undefined ? {} : { severedAt: severedAt as string | null }),
    ...(mode === undefined ? {} : { mode: mode as FollowMode }),
    ...(upstreamBehind === undefined ? {} : { upstreamBehind: upstreamBehind as number | null }),
    ...(conflict === undefined ? {} : { conflict }),
    ...(claimedOk ? { claimed } : {}),
    ...(everydayOk ? { everyday } : {}),
    ...(told !== undefined && toldOk ? { lastTellAt: told as string | null } : {}),
  };
}

const beatPath = (app: App, name: string): string =>
  join(app.config.dataDir, "beats", `${name}.json`);

/** What this forge heard, and when (ms), for one child. */
export interface Heard {
  readonly beat: Beat;
  readonly receivedAt: number;
}

export async function lastHeard(app: App, name: string): Promise<Heard | undefined> {
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

/** What the crew spent today, and the daily ceiling that pauses it (null when the forge sets none). */
export function spendReport(app: App, now = new Date()): { spendTodayUsd: number; ceilingUsd: number | null } {
  const cap = forgeCeiling(app.config);
  return {
    spendTodayUsd: Math.min(Math.round(spentTodayEverywhere(app.db, now) * 100) / 100, USD_MAX),
    ceilingUsd: cap === null ? null : Math.min(cap, USD_MAX),
  };
}

/** What a fork says of how it follows: its tip, whether it cut the link, and how far behind it is. */
async function forkReport(app: App, forge: ForgeLink) {
  const up = await upstreamState(app);
  const behind = up?.behind ?? null;
  return {
    forgeTip: await forgeTipOf(app),
    severedAt: forge.severedAt ?? null,
    mode: forge.mode,
    upstreamBehind: behind === null ? null : Math.min(behind, COUNT_MAX),
    conflict: up?.taken?.kind === "conflict" && up.taken.issue !== null,
  };
}

/** In a cell the parent's public address is out of reach; its relayed loopback port (`FORGE_PARENT_LOCAL`) is not. */
function beatBase(upstream: string): string {
  const local = process.env["FORGE_PARENT_LOCAL"] ?? "";
  return isParentLocal(local) ? local : upstream;
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
  const forge = await forgeLinkOf(app);
  // Strictly later than the last one sent, so a quick restart is not a replay.
  lastAt = Math.max(now, lastAt + 1);
  const body = JSON.stringify({
    ...standing(app, link.name, lastAt),
    children: Math.min(own, COUNT_MAX),
    ...spendReport(app),
    ...progress(app),
    // Only a forge that carries a fork of its parent's code has these to say.
    ...(forge === undefined
      ? {}
      : await forkReport(app, forge)),
  });
  try {
    const res = await fetcher(`${beatBase(link.upstream)}/api/v1/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json", [SIGNATURE_HEADER]: sign(link.key, body) },
      body,
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    if (res.ok) await refreshFunding(app, fetcher);
    return res.ok;
  } catch {
    return false;
  }
}

/** Report now and then every BEAT_MS; returns the timer to clear. */
export function startHeartbeat(app: App): ReturnType<typeof setInterval> {
  void sendBeat(app);
  return setInterval(() => void during("heartbeat", () => sendBeat(app)), BEAT_MS);
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
  /** The tip of the child's own forge code, as last reported; null when none. */
  readonly forgeTip: string | null;
  /** When the child cut its link to this forge's code; null while it follows or when unheard. */
  readonly severedAt: string | null;
  /** How the child follows this forge's code; null when it did not say. */
  readonly mode: FollowMode | null;
  /** Commits the child's code is behind this forge's; null when unknown or unsaid. */
  readonly upstreamBehind: number | null;
  /** A converge issue is open on the child; false when none or unsaid. */
  readonly conflict: boolean;
  /** Dollars the child's crew spent today, as last reported; null when unsaid. */
  readonly spendTodayUsd: number | null;
  /** The child's forge cap in dollars; null when it has none or did not say. */
  readonly ceilingUsd: number | null;
}

/** How many releases of this forge are newer than `version`; null when it is not one of them. */
export function releasesBehind(version: string): number | null {
  const i = shippedReleases().findIndex((r) => r.version === version);
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
      forgeTip: heard?.beat.forgeTip ?? null,
      severedAt: heard?.beat.severedAt ?? null,
      mode: heard?.beat.mode ?? null,
      upstreamBehind: heard?.beat.upstreamBehind ?? null,
      conflict: heard?.beat.conflict ?? false,
      spendTodayUsd: heard?.beat.spendTodayUsd ?? null,
      ceilingUsd: heard?.beat.ceilingUsd ?? null,
    });
  }
  return { items, more: Math.max(0, all.length - MAX_CHILDREN) };
}

/** The address of the forge that sent this one, when it was spawned and told. */
export async function parentUpstream(app: App): Promise<string | undefined> {
  return (await parentLink(app))?.upstream;
}
