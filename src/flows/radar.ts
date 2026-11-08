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
  /** One line about a known advisory for the pinned version, or absent. */
  readonly advisory?: string;
}

/** Asks upstream about one package: its newest version, or why it could not say. */
export type Lookup = (name: string, version: string) => Promise<Upstream | string>;

export interface DepLine {
  readonly name: string;
  readonly range: string;
  readonly pinned: string;
  readonly latest: string;
  readonly gap: Gap;
  readonly dev: boolean;
  readonly advisory: string;
  readonly error: string;
  readonly checkedAt: string | null;
}

const MAX_PINS = 200;
/** Registry asks in flight at once, and the whole run's budget: a run never holds a worker for minutes. */
export const CONCURRENCY = 4;
export const RUN_DEADLINE_MS = 30_000;

/** The npm registry's answer for one package; the name is validated before it is put in a URL. */
export const npmLookup: Lookup = async (name, version) => {
  if (!NPM_NAME.test(name)) return "not a package name";
  try {
    const res = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2F")}/latest`, {
      signal: AbortSignal.timeout(5000),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return `registry answered ${res.status}`;
    const body: unknown = await res.json();
    const latest = typeof body === "object" && body !== null ? (body as { version?: unknown }).version : undefined;
    if (typeof latest !== "string" || !parseSemver(latest)) return "no version in the answer";
    return { latest, advisory: await npmAdvisory(name, version) };
  } catch {
    return "registry not reachable";
  }
};

/** The registry's advisory for one package at one version: its first title, or "" (none, no exact version, or not reachable). */
async function npmAdvisory(name: string, version: string): Promise<string> {
  if (version === "" || !NPM_NAME.test(name)) return "";
  try {
    const res = await fetch("https://registry.npmjs.org/-/npm/v1/security/advisories/bulk", {
      method: "POST",
      signal: AbortSignal.timeout(5000),
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ [name]: [version] }),
    });
    if (!res.ok) return "";
    const body: unknown = await res.json();
    const list = typeof body === "object" && body !== null ? (body as Record<string, unknown>)[name] : undefined;
    const first = Array.isArray(list) ? (list[0] as { title?: unknown; severity?: unknown } | undefined) : undefined;
    if (typeof first?.title !== "string") return "";
    const more = (list as unknown[]).length - 1;
    return `${typeof first.severity === "string" ? `${first.severity.slice(0, 20)}: ` : ""}${first.title.slice(0, 130)}${more > 0 ? ` (+${more} more)` : ""}`;
  } catch {
    return "";
  }
}

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
    `INSERT INTO dep_latest (repo_id, name, latest, error, checked_at, advisory) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT (repo_id, name) DO UPDATE SET latest = excluded.latest,
       error = excluded.error, checked_at = excluded.checked_at, advisory = excluded.advisory`,
  );
  const todo = pins.slice(0, MAX_PINS).filter((p) => p.version !== "");
  const stop = Date.now() + deadlineMs;
  let next = 0;
  let written = 0;
  const worker = async (): Promise<void> => {
    while (next < todo.length && Date.now() < stop) {
      const pin = todo[next++]!;
      const answer = await lookup(pin.name, pin.version);
      const at = now.toISOString();
      if (typeof answer === "string") put.run(repoId, pin.name, "", answer.slice(0, 200), at, "");
      else put.run(repoId, pin.name, answer.latest, "", at, (answer.advisory ?? "").slice(0, 200));
      written++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));
  return written;
}

interface Row { name: string; latest: string; error: string; checked_at: string; advisory: string }

/** Each pin with what the radar last read, outdated first. */
export function readRadar(db: Database, repoId: string, pins: readonly Pin[]): DepLine[] {
  const rows = new Map(
    db.query<Row, [string]>("SELECT name, latest, error, checked_at, advisory FROM dep_latest WHERE repo_id = ?1").all(repoId).map((r) => [r.name, r]),
  );
  const rank: Record<Gap, number> = { major: 0, minor: 1, patch: 2, none: 3 };
  return pins
    .map((p): DepLine => {
      const r = rows.get(p.name);
      const a = parseSemver(p.version);
      const b = parseSemver(r?.latest ?? "");
      return {
        name: p.name, range: p.range, pinned: p.version, latest: r?.latest ?? "", dev: p.dev,
        gap: a && b ? gapOf(a, b) : "none", advisory: r?.advisory ?? "", error: r?.error ?? "", checkedAt: r?.checked_at ?? null,
      };
    })
    .sort((x, y) => rank[x.gap] - rank[y.gap] || x.name.localeCompare(y.name));
}

/** How a package stands, worded once for the page and the terminal: an advisory outranks a read error, which outranks the gap. */
export function depState(d: DepLine): { label: string; tone: "danger" | "attn" | "default" } {
  if (d.advisory !== "") return { label: "advisory", tone: "danger" };
  if (d.error !== "") return { label: "not read", tone: "danger" };
  if (d.gap === "none") return { label: d.checkedAt === null ? "not read yet" : "current", tone: "default" };
  return { label: `${d.gap} update`, tone: d.gap === "major" ? "danger" : "attn" };
}
