/**
 * The releases of the forge this one was spawned from, read over HTTPS.
 *
 * A child names its parent's URL (`FORGE_PARENT_URL`); the parent answers
 * `GET <url>/releases.json` with `{ "releases": [{ "name", "url" }] }`,
 * newest first. Read only: nothing here takes an update.
 *
 * The read is bounded (a timeout and a size cap), cached under the data
 * directory for ten minutes, and never throws. A page never waits for the
 * parent: it renders what the cache holds at once, and a stale or missing
 * cache starts a refresh in the background for the next view. A parent that
 * is down, slow, or answering garbage costs a page nothing: it gets the last
 * good copy and that copy's age, or an honest "unreachable" when there is
 * none. A failed try is remembered for a minute so a dead parent is not
 * asked on every view.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { running } from "../kernel/version.ts";

export const FRESH_MS = 10 * 60_000;
export const RETRY_MS = 60_000;
const TIMEOUT_MS = 3_000;
const MAX_BYTES = 256 * 1024;
const MAX_RELEASES = 100;

export interface ParentRelease {
  readonly name: string;
  readonly url: string;
}

export interface ParentReleases {
  readonly releases: readonly ParentRelease[];
  /** When the copy shown was fetched, or null when there is none. */
  readonly fetchedAt: number | null;
  /** True when the last try failed (a copy may still be shown). */
  readonly down: boolean;
  /** True when a refresh has been started and nothing has answered yet. */
  readonly checking: boolean;
}

/** Why `raw` cannot name a parent, or null. `loopback` allows plain http (tests). */
export function parentUrlProblem(raw: string, loopback = false): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "not a URL";
  }
  if (u.protocol !== "https:" && !(loopback && u.protocol === "http:"))
    return "must be https";
  if (u.username !== "" || u.password !== "")
    return "must not carry credentials";
  if (u.search !== "" || u.hash !== "") return "must not carry a query";
  return null;
}

/** A release's link: http(s) only (http for loopback tests), no credentials; a fragment is fine. */
function link(raw: unknown, loopback: boolean): string | null {
  if (typeof raw !== "string" || raw.length > 500) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const ok = u.protocol === "https:" || (loopback && u.protocol === "http:");
  return ok && u.username === "" && u.password === "" ? raw : null;
}

/** The entries of a releases document that are well formed; undefined when it is not one. */
export function parseReleases(
  doc: unknown,
  loopback = false,
): ParentRelease[] | undefined {
  if (typeof doc !== "object" || doc === null) return undefined;
  const list = (doc as { releases?: unknown }).releases;
  if (!Array.isArray(list)) return undefined;
  const out: ParentRelease[] = [];
  for (const e of list.slice(0, MAX_RELEASES)) {
    if (typeof e !== "object" || e === null) continue;
    const name = (e as { name?: unknown }).name;
    const url = link((e as { url?: unknown }).url, loopback);
    if (typeof name !== "string" || url === null) continue;
    const n = name.trim();
    if (n === "" || n.length > 80) continue;
    out.push({ name: n, url });
  }
  return out;
}

/**
 * How many of the parent's releases (newest first) come after `version`;
 * undefined when `version` is not in the list (an unknown or newer build),
 * where a count would be a guess.
 */
export function releasesBehind(
  releases: readonly ParentRelease[],
  version: string,
): number | undefined {
  const at = releases.findIndex((r) => r.name === version);
  return at === -1 ? undefined : at;
}

interface Stored {
  url: string;
  fetchedAt: number | null;
  triedAt: number;
  ok: boolean;
  releases: ParentRelease[];
}

function readStored(file: string, url: string): Stored | undefined {
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as Stored;
    if (s.url !== url || !Array.isArray(s.releases)) return undefined;
    return s;
  } catch {
    return undefined;
  }
}

async function fetchDoc(url: string, f: typeof fetch): Promise<unknown> {
  const res = await f(`${url.replace(/\/+$/, "")}/releases.json`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: "error",
    headers: { accept: "application/json" },
  });
  if (!res.ok || res.body === null) throw new Error(`status ${res.status}`);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new Error("too large");
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const refreshing = new Map<string, Promise<void>>();

/** Reads the parent now and stores the answer; one refresh at a time per cache. */
export function refreshParentReleases(
  dataDir: string,
  url: string,
  opts: { now?: number; loopback?: boolean; fetch?: typeof fetch } = {},
): Promise<void> {
  const file = join(dataDir, "parent-releases.json");
  const running = refreshing.get(file);
  if (running !== undefined) return running;
  const job = (async () => {
    const now = opts.now ?? Date.now();
    const kept = readStored(file, url);
    const copy = kept?.fetchedAt ?? null;
    let next: Stored;
    try {
      const releases = parseReleases(
        await fetchDoc(url, opts.fetch ?? fetch),
        opts.loopback ?? false,
      );
      if (releases === undefined) throw new Error("not a releases document");
      next = { url, fetchedAt: now, triedAt: now, ok: true, releases };
    } catch {
      next = {
        url,
        fetchedAt: copy,
        triedAt: now,
        ok: false,
        releases: copy === null ? [] : (kept?.releases ?? []),
      };
    }
    try {
      mkdirSync(dataDir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(next));
      renameSync(tmp, file);
    } catch {
      // A cache that cannot be written is a cache miss next time, not a failure.
    }
  })().finally(() => refreshing.delete(file));
  refreshing.set(file, job);
  return job;
}

/**
 * What the cache holds, at once. A copy older than ten minutes (or none, and
 * no try in the last minute) starts a refresh in the background; the caller
 * does not wait for it. The returned promise settles when it has (for tests).
 */
export function parentReleases(
  dataDir: string,
  url: string,
  opts: { now?: number; loopback?: boolean; fetch?: typeof fetch } = {},
): ParentReleases & { refresh: Promise<void> | undefined } {
  const now = opts.now ?? Date.now();
  const kept = readStored(join(dataDir, "parent-releases.json"), url);
  const fetchedAt = kept?.fetchedAt ?? null;
  const fresh = fetchedAt !== null && now - fetchedAt < FRESH_MS;
  const tried = kept !== undefined && now - kept.triedAt < RETRY_MS;
  const refresh =
    fresh || tried ? undefined : refreshParentReleases(dataDir, url, opts);
  return {
    releases: kept?.releases ?? [],
    fetchedAt,
    down: kept !== undefined && !kept.ok,
    checking: refresh !== undefined && kept === undefined,
    refresh,
  };
}

/**
 * The sentence both doors say: how far behind, or why not, and how old the
 * copy is when the parent cannot be reached.
 */
export function releasesSentence(
  r: ParentReleases,
  version: string,
  host: string,
  now = Date.now(),
): string {
  if (r.fetchedAt === null)
    return r.checking || !r.down
      ? `Checking ${host} for releases…`
      : `${host} could not be reached.`;
  const behind = releasesBehind(r.releases, version);
  const count =
    behind === undefined
      ? `This version (${version}) is not in ${host}'s list of releases.`
      : behind === 0
        ? `No releases behind ${host}.`
        : `${behind} ${behind === 1 ? "release" : "releases"} behind ${host}.`;
  return r.down
    ? `${count} ${host} could not be reached; this is a copy from ${ageWords(now - r.fetchedAt)} ago.`
    : count;
}

/** "3 minutes", "2 hours": the age of a copy, in one phrase. */
export function ageWords(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 1) return "under a minute";
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"}`;
  const d = Math.floor(h / 24);
  return `${d} days`;
}

/** The parent forge as plain data, for the JSON and MCP doors. */
export interface ParentForge {
  readonly host: string;
  /** Releases behind, or null when unknown (nothing fetched, or not listed). */
  readonly behind: number | null;
  /** The releases behind, newest first. */
  readonly releases: readonly ParentRelease[];
  readonly fetchedAt: number | null;
  readonly down: boolean;
}

/** `{host, behind, releases, fetchedAt, down}` from a cache view. */
export function parentForgeOf(
  parentUrl: string,
  view: ParentReleases,
  version: string,
): ParentForge {
  const behind = releasesBehind(view.releases, version) ?? null;
  return {
    host: new URL(parentUrl).host,
    behind: view.fetchedAt === null ? null : behind,
    releases: view.releases.slice(0, behind ?? 0),
    fetchedAt: view.fetchedAt,
    down: view.down,
  };
}

/** The parent forge for this forge's config, or null when none is named. */
export function parentForgeFor(config: {
  parentUrl?: string;
  parentLoopback?: boolean;
  dataDir: string;
}): ParentForge | null {
  if (config.parentUrl === undefined) return null;
  const view = parentReleases(config.dataDir, config.parentUrl, {
    loopback: config.parentLoopback === true,
  });
  return parentForgeOf(config.parentUrl, view, running().version);
}
