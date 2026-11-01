/**
 * What went live, as the changelog, the MCP `releases` read and the "no
 * release" alarm all read it: the pulls merged into a default branch, each
 * live or on its way. A pull to the forge's own repository is live once the
 * running commit (the one health reports) contains its merge commit; a pull
 * to any other repository is live when it lands, for production follows
 * its default branch. Only public repositories are listed.
 *
 * Ancestry is asked of git, once per merge commit while it is live: the
 * answer is kept in memory, so a request costs one query and the few pulls
 * still on their way. The alarm is synchronous, so it reads what the last
 * `readLandings` kept and says nothing until something has been read.
 */

import type { Database } from "bun:sqlite";
import type { App } from "../app.ts";
import { getRepo } from "../core/repos.ts";
import { runGit } from "../git/env.ts";
import { repoDir } from "../git/repos.ts";
import { running } from "../kernel/version.ts";

export interface Landing {
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  /** When the pull merged. */
  readonly at: string;
  readonly live: boolean;
}

export interface Landings {
  readonly version: string;
  readonly commit: string | null;
  /** The forge's own repository, `owner/name`, when it has one here. */
  readonly own: string | undefined;
  /** Live, newest first. */
  readonly live: readonly Landing[];
  /** Merged, not yet in the running commit, newest first. */
  readonly onItsWay: readonly Landing[];
}

/** More merged pulls than this are older than anything the page shows. */
const ROWS = 300;
/** Merge commits of the forge's own repository asked of git on one read. */
const ASKED = 80;

export interface MergedRow {
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly at: string;
  readonly oid: string;
}

/** The merged pulls of public repositories, newest first. */
export function mergedRows(db: Database, limit = ROWS): MergedRow[] {
  return db
    .query<{ repo: string; number: number; title: string; at: string; oid: string | null }, [number]>(
      `SELECT u.username || '/' || r.name AS repo, i.number, i.title, p.merged_at AS at, p.merged_oid AS oid
         FROM pull p JOIN issue i ON i.id = p.issue_id JOIN repo r ON r.id = i.repo_id JOIN user u ON u.id = r.owner_id
        WHERE p.merged_at IS NOT NULL AND p.base_branch = r.default_branch AND r.visibility = 'public'
        ORDER BY p.merged_at DESC LIMIT ?1`,
    )
    .all(limit)
    .map((r) => ({ ...r, oid: r.oid ?? "" }));
}

/** What the running commit contains, as the last read found it. */
interface LiveState {
  readonly own: string;
  /** Merge commits known to be in the running commit. */
  readonly oids: ReadonlySet<string>;
  /** When the running commit was made; stands in for a merge commit the pull never recorded. */
  readonly at: number;
  /** The running commit these were asked of. */
  readonly commit: string;
}
let kept: LiveState | undefined;

/** Keep what the running commit contains; a test says it directly. */
export function keepLive(own: string, oids: Iterable<string>, at: number): void {
  kept = { own, oids: new Set(oids), at, commit: "" };
}

/** Forget it, so the alarm is silent until the next read. */
export function forgetLive(): void {
  kept = undefined;
}

function isLive(row: MergedRow, state: LiveState | undefined): boolean {
  if (state === undefined || row.repo.toLowerCase() !== state.own.toLowerCase()) return true;
  return row.oid === "" ? Date.parse(row.at) <= state.at : state.oids.has(row.oid);
}

/**
 * The merged pulls split by whether they are live. A pull of the forge's own
 * repository that is not in the running commit but merged before a live one
 * is not on its way, just not in this history: it counts as live.
 */
export function split(rows: readonly MergedRow[], state: LiveState | undefined): { live: Landing[]; onItsWay: Landing[] } {
  const newestLive = rows.find((r) => isLive(r, state));
  const out: { live: Landing[]; onItsWay: Landing[] } = { live: [], onItsWay: [] };
  for (const r of rows) {
    const live = isLive(r, state) || (newestLive !== undefined && r.at < newestLive.at);
    const landing: Landing = { repo: r.repo, number: r.number, title: r.title, at: r.at, live };
    (live ? out.live : out.onItsWay).push(landing);
  }
  return out;
}

/** The oldest landing still on its way, from what the last read kept; undefined when none or nothing was read. */
export function waitingSince(db: Database): string | undefined {
  if (kept === undefined) return undefined;
  const { onItsWay } = split(mergedRows(db), kept);
  return onItsWay.at(-1)?.at;
}

/** Ask git which of the forge's own merge commits the running commit contains. */
async function askLive(app: App, rows: readonly MergedRow[]): Promise<void> {
  const own = app.config.forgeRepo ?? "";
  const [owner = "", name = ""] = own.split("/");
  const repo = owner === "" || name === "" ? undefined : getRepo(app.db, owner, name);
  if (repo === undefined) return;
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const head = running().commit ?? (await runGit(["rev-parse", "--verify", "-q", `refs/heads/${repo.defaultBranch}`], { cwd: dir }));
  const commit = typeof head === "string" ? head : head.ok ? head.value : undefined;
  if (commit === undefined) return;
  const made = await runGit(["show", "-s", "--format=%ct", commit], { cwd: dir });
  if (!made.ok) return;
  const named = `${repo.ownerName}/${repo.name}`;
  // A live commit's ancestors stay ancestors; only a new running commit voids what was kept.
  const before = kept?.own === named && kept.commit === commit ? kept : undefined;
  const oids = new Set(before?.oids ?? []);
  const wanted = rows
    .filter((r) => r.repo.toLowerCase() === named.toLowerCase() && r.oid !== "" && !oids.has(r.oid))
    .slice(0, ASKED);
  await Promise.all(
    wanted.map(async (r) => {
      const ancestor = await runGit(["merge-base", "--is-ancestor", r.oid, commit], { cwd: dir });
      if (ancestor.ok) oids.add(r.oid);
    }),
  );
  kept = { own: named, oids, at: Number(made.value) * 1000, commit };
}

/** Every landing, live or on its way, as of the running commit. */
export async function readLandings(app: App): Promise<Landings> {
  const rows = mergedRows(app.db);
  await askLive(app, rows).catch(() => undefined);
  const { live, onItsWay } = split(rows, kept);
  const { version, commit } = running();
  return { version, commit, own: kept?.own, live, onItsWay };
}
