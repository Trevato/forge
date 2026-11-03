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
import { getRepo, type Repo } from "../core/repos.ts";
import { creditsOf } from "../git/coauthors.ts";
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
  /** The bet whose scopes this pull built (#8713), set by the page that shows it. */
  readonly bet?: string;
  /** `account@host` when a trusted source's work folded in (#8937), set by the page that shows it. */
  readonly from?: string;
  /** Others credited on the landed commit (`Co-authored-by`), beyond whoever landed it. */
  readonly with?: readonly string[];
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

/** Which repository the reader asked for: "" for this forge's own, "all", or one named in the list; anything else is the default. */
export function chosenRepo(asked: string | null, all: readonly Landing[], own: string | undefined): string {
  if (asked === "all") return "all";
  if (asked !== null && all.some((l) => l.repo === asked)) return asked;
  return own === undefined ? "all" : own;
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
  /** Merge commits found not to be in the running commit; they cannot become so while it stays. */
  readonly misses: ReadonlySet<string>;
  /** When the running commit was made; stands in for a merge commit the pull never recorded. */
  readonly at: number;
  /** The running commit these were asked of. */
  readonly commit: string;
}
let kept: LiveState | undefined;

/** Keep what the running commit contains; a test says it directly. */
export function keepLive(own: string, oids: Iterable<string>, at: number): void {
  kept = { own, oids: new Set(oids), misses: new Set(), at, commit: "" };
}

/** Forget it, so the alarm is silent until the next read. */
export function forgetLive(): void {
  kept = undefined;
  found.clear();
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

/** How long a miss is believed: a repository can turn public, or merge its first pull, after boot. */
const MISS_MS = 60_000;

/** The repository the running commit was built from, per running commit; "" when none held it at `at`. */
const found = new Map<string, { repo: string; at: number }>();

/**
 * The forge's own repository: the one `FORGE_REPO` names or, where a deploy
 * names none, the public repository with merged pulls whose history holds the
 * running commit. When several do (a public fork), the one with the most
 * merged pulls wins, then the first by name. Read-only: nothing here changes
 * how releases cut.
 */
async function ownRepo(app: App, rows: readonly MergedRow[], now = Date.now()): Promise<Repo | undefined> {
  const [owner = "", name = ""] = (app.config.forgeRepo ?? "").split("/");
  if (owner !== "" && name !== "") return getRepo(app.db, owner, name);
  const commit = running().commit;
  if (commit === null) return undefined;
  const known = found.get(commit);
  if (known?.repo === "" && now - known.at < MISS_MS) return undefined;
  for (const named of known?.repo ? [known.repo] : candidates(rows)) {
    const [o = "", n = ""] = named.split("/");
    const repo = getRepo(app.db, o, n);
    if (repo === undefined || repo.visibility !== "public") continue;
    const has = await runGit(["cat-file", "-e", `${commit}^{commit}`], { cwd: repoDir(app.reposRoot, repo.ownerName, repo.name) });
    if (!has.ok) continue;
    found.set(commit, { repo: named, at: now });
    return repo;
  }
  // A miss is kept a minute so requests cost no git; with no merged pulls yet there is nothing to remember.
  if (rows.length > 0) found.set(commit, { repo: "", at: now });
  else found.delete(commit);
  return undefined;
}

/** The repositories of `rows`, most merged pulls first, then by name. */
export function candidates(rows: readonly MergedRow[]): string[] {
  const count = new Map<string, number>();
  for (const r of rows) count.set(r.repo, (count.get(r.repo) ?? 0) + 1);
  return [...count].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0)).map(([r]) => r);
}

/** Ask git which of the forge's own merge commits the running commit contains. */
async function askLive(app: App, rows: readonly MergedRow[]): Promise<void> {
  const repo = await ownRepo(app, rows);
  if (repo === undefined) return;
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const head = running().commit ?? (await runGit(["rev-parse", "--verify", "-q", `refs/heads/${repo.defaultBranch}`], { cwd: dir }));
  const commit = typeof head === "string" ? head : head.ok ? head.value : undefined;
  if (commit === undefined) return;
  const named = `${repo.ownerName}/${repo.name}`;
  // For one running commit an ancestor stays one and a non-ancestor never becomes one:
  // only a new running commit voids what was kept.
  const before = kept?.own === named && kept.commit === commit ? kept : undefined;
  let at = before?.at;
  if (at === undefined) {
    const made = await runGit(["show", "-s", "--format=%ct", commit], { cwd: dir });
    if (!made.ok) return;
    at = Number(made.value) * 1000;
  }
  const oids = new Set(before?.oids ?? []);
  const misses = new Set(before?.misses ?? []);
  const wanted = rows
    .filter((r) => r.repo.toLowerCase() === named.toLowerCase() && r.oid !== "" && !oids.has(r.oid) && !misses.has(r.oid))
    .slice(0, ASKED);
  await Promise.all(
    wanted.map(async (r) => {
      const ancestor = await runGit(["merge-base", "--is-ancestor", r.oid, commit], { cwd: dir });
      if (ancestor.ok) oids.add(r.oid);
      // Exit 1 is git's "no"; any other failure may pass, so it is asked again.
      else if (ancestor.error.code === 1) misses.add(r.oid);
    }),
  );
  // Misses are kept only for the merged rows still listed.
  const listed = new Set(rows.map((r) => r.oid));
  for (const o of misses) if (!listed.has(o)) misses.delete(o);
  kept = { own: named, oids, misses, at, commit };
}

/** The names credited on the forge's own landed commits, by `repo#number`. */
async function creditsOfRepo(app: App, own: string, rows: readonly MergedRow[]): Promise<Map<string, readonly string[]>> {
  const [owner = "", name = ""] = own.split("/");
  const repo = getRepo(app.db, owner, name);
  if (repo === undefined) return new Map();
  const mine = rows.filter((r) => r.repo.toLowerCase() === own.toLowerCase() && r.oid !== "").slice(0, ASKED);
  const byOid = await creditsOf(repoDir(app.reposRoot, repo.ownerName, repo.name), mine.map((r) => r.oid));
  return new Map(mine.map((r) => [`${r.repo}#${r.number}`, byOid.get(r.oid) ?? []] as const));
}

/** Every landing, live or on its way, as of the running commit. */
export async function readLandings(app: App): Promise<Landings> {
  const rows = mergedRows(app.db);
  await askLive(app, rows).catch(() => undefined);
  const { live, onItsWay } = split(rows, kept);
  const own = kept?.own;
  const credits = own === undefined ? new Map<string, readonly string[]>() : await creditsOfRepo(app, own, rows).catch(() => new Map<string, readonly string[]>());
  const named = (l: Landing): Landing => {
    const names = credits.get(`${l.repo}#${l.number}`) ?? [];
    return names.length === 0 ? l : { ...l, with: names };
  };
  const { version, commit } = running();
  return { version, commit, own, live: live.map(named), onItsWay: onItsWay.map(named) };
}
