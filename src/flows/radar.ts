/**
 * The dependency radar's deterministic core (#9434): read what a repository
 * pins, ask upstream for the newest version of each, keep the answer. No
 * model and no credential: the same pins and the same registry give the same
 * rows. The lookup is injected so a test (and a forge with no outbound
 * network) never reaches the registry.
 */

import type { Database } from "bun:sqlite";
import { NPM_NAME, type Pin } from "./pins.ts";
import { gapOf, parseSemver, type Gap } from "./semver.ts";

export interface Upstream {
  readonly latest: string;
}

/** Asks upstream about one package: its newest version, or why it could not say. */
export type Lookup = (name: string) => Promise<Upstream | string>;

export interface DepLine {
  readonly name: string;
  readonly range: string;
  readonly pinned: string;
  readonly latest: string;
  readonly gap: Gap;
  readonly dev: boolean;
  readonly error: string;
  readonly checkedAt: string | null;
}

const MAX_PINS = 200;
/** Registry asks in flight at once, and the whole run's budget: a run never holds a worker for minutes. */
export const CONCURRENCY = 4;
export const RUN_DEADLINE_MS = 30_000;

/** The npm registry's answer for one package; the name is validated before it is put in a URL. */
export const npmLookup: Lookup = async (name) => {
  if (!NPM_NAME.test(name)) return "not a package name";
  try {
    const res = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2F")}/latest`, {
      signal: AbortSignal.timeout(5000),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return `registry answered ${res.status}`;
    const body: unknown = await res.json();
    const version = typeof body === "object" && body !== null ? (body as { version?: unknown }).version : undefined;
    return typeof version === "string" && parseSemver(version) ? { latest: version } : "no version in the answer";
  } catch {
    return "registry not reachable";
  }
};

/**
 * Read upstream for every exact pin and store the answers, a few at a time and
 * within a total deadline; a pin not reached keeps its last row. Returns how
 * many rows were written.
 */
export async function refreshRadar(
  db: Database,
  repoId: string,
  pins: readonly Pin[],
  lookup: Lookup,
  now = new Date(),
  deadlineMs = RUN_DEADLINE_MS,
): Promise<number> {
  const put = db.query(
    `INSERT INTO dep_latest (repo_id, name, latest, error, checked_at) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (repo_id, name) DO UPDATE SET latest = excluded.latest,
       error = excluded.error, checked_at = excluded.checked_at`,
  );
  const todo = pins.slice(0, MAX_PINS).filter((p) => p.version !== "");
  const stop = Date.now() + deadlineMs;
  let next = 0;
  let written = 0;
  const worker = async (): Promise<void> => {
    while (next < todo.length && Date.now() < stop) {
      const pin = todo[next++]!;
      const answer = await lookup(pin.name);
      const at = now.toISOString();
      if (typeof answer === "string") put.run(repoId, pin.name, "", answer.slice(0, 200), at);
      else put.run(repoId, pin.name, answer.latest, "", at);
      written++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));
  return written;
}

interface Row { name: string; latest: string; error: string; checked_at: string }

/** Each pin with what the radar last read, outdated first. */
export function readRadar(db: Database, repoId: string, pins: readonly Pin[]): DepLine[] {
  const rows = new Map(
    db.query<Row, [string]>("SELECT name, latest, error, checked_at FROM dep_latest WHERE repo_id = ?1").all(repoId).map((r) => [r.name, r]),
  );
  const rank: Record<Gap, number> = { major: 0, minor: 1, patch: 2, none: 3 };
  return pins
    .map((p): DepLine => {
      const r = rows.get(p.name);
      const a = parseSemver(p.version);
      const b = parseSemver(r?.latest ?? "");
      return {
        name: p.name, range: p.range, pinned: p.version, latest: r?.latest ?? "", dev: p.dev,
        gap: a && b ? gapOf(a, b) : "none", error: r?.error ?? "", checkedAt: r?.checked_at ?? null,
      };
    })
    .sort((x, y) => rank[x.gap] - rank[y.gap] || x.name.localeCompare(y.name));
}
