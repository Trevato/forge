/**
 * Iterations, the data: a fork family's build pins as plain data, and the
 * downward tree's runs drawn from them. No HTML here; `iterations.ts` draws.
 *
 * A pin hangs under the parent its person named (`BuildPin.parent`: a label
 * here, or `owner/name:label` for a concept edge to another pin of the
 * family), else it continues its repository's run, oldest first. A fork
 * carries its parent's pins; the family draws each once, in the parent.
 */

import { canRead, getRepoById, visibleForks, type Repo } from "../../core/repos.ts";
import { listBuildPins, type BuildPin } from "../../git/builds.ts";
import { repoDir } from "../../git/repos.ts";
import type { App } from "../../app.ts";
import type { User } from "../../core/users.ts";

/** How many repositories a family draws. */
export const FAMILY_LIMIT = 40;

export interface IterationBuild {
  /** `owner/name:label`. */
  readonly key: string;
  readonly label: string;
  readonly oid: string;
  /** ISO time it was pinned. */
  readonly at: string;
  /** The first line of its note. */
  readonly note: string;
  /** The key of the build it hangs under, when that is in the family. */
  readonly parent: string | null;
  readonly edge: "git" | "concept" | null;
}

export interface IterationFork {
  /** `owner/name`. */
  readonly repo: string;
  readonly name: string;
  /** The repository it was forked from, when that is in the family. */
  readonly forkOf: string | null;
  /** Oldest first. */
  readonly builds: readonly IterationBuild[];
}

export interface IterationLane {
  /** The repository for a fork's main run, else the key of the run's first build. */
  readonly id: string;
  readonly repo: string;
  readonly title: string;
  readonly main: boolean;
  /** The build it grew from; null for a root. */
  readonly from: string | null;
  /** For a main run with no build to hang from, the repository it was forked from. */
  readonly fromRepo: string | null;
  readonly kind: "fork" | "branch" | "concept";
  readonly builds: readonly IterationBuild[];
}

/** The repositories the viewer may read: up to the root, then every fork below, root first. */
export function familyRepos(app: App, viewer: User | undefined, repo: Repo, limit = FAMILY_LIMIT): Repo[] {
  const db = app.db;
  let root = repo;
  for (let i = 0; i < limit && root.forkParentId !== null; i++) {
    const up = getRepoById(db, root.forkParentId);
    if (up === undefined || !canRead(db, up, viewer)) break;
    root = up;
  }
  const repos: Repo[] = [root];
  for (let i = 0; i < repos.length && repos.length < limit; i++)
    repos.push(...visibleForks(db, repos[i]!.id, viewer).slice(0, limit - repos.length));
  return repos;
}

/** A pin the fork inherited: the same label on the same commit in its parent. */
const copied = (pin: BuildPin, up: readonly BuildPin[]): boolean => up.some((p) => p.label === pin.label && p.oid === pin.oid);

/**
 * A repository's pins are read from git, one process each, up to
 * FAMILY_LIMIT at a time; a read is kept this long per repository so a reload
 * or a second viewer costs no process. A new pin shows within this time.
 */
export const PINS_TTL_MS = 5000;
const kept = new WeakMap<App, Map<string, { at: number; pins: Promise<BuildPin[]> }>>();

function pinsOf(app: App, repo: Repo, now: number): Promise<BuildPin[]> {
  let mine = kept.get(app);
  if (mine === undefined) kept.set(app, (mine = new Map()));
  const hit = mine.get(repo.id);
  if (hit !== undefined && now - hit.at < PINS_TTL_MS) return hit.pins;
  const pins = listBuildPins(repoDir(app.reposRoot, repo.ownerName, repo.name));
  mine.set(repo.id, { at: now, pins });
  if (mine.size > 4 * FAMILY_LIMIT) for (const [id, v] of mine) if (now - v.at >= PINS_TTL_MS) mine.delete(id);
  pins.catch(() => mine.delete(repo.id));
  return pins;
}

/** The family's pins as fork cards; undefined when it holds none. */
export async function iterationsOf(app: App, viewer: User | undefined, repo: Repo, limit = FAMILY_LIMIT): Promise<IterationFork[] | undefined> {
  const family = familyRepos(app, viewer, repo, limit);
  const now = Date.now();
  const names = new Map(family.map((r) => [r.id, `${r.ownerName}/${r.name}`]));
  const pins = new Map<string, BuildPin[]>();
  await Promise.all(
    family.map(async (r) => pins.set(r.id, [...(await pinsOf(app, r, now))])),
  );
  for (const r of family) {
    const up = r.forkParentId === null ? undefined : pins.get(r.forkParentId);
    if (up !== undefined) pins.set(r.id, pins.get(r.id)!.filter((p) => !copied(p, up)));
  }
  if ([...pins.values()].every((p) => p.length === 0)) return undefined;
  const known = new Set(family.flatMap((r) => pins.get(r.id)!.map((p) => `${names.get(r.id)}:${p.label}`)));
  const forks: IterationFork[] = [];
  for (const r of family) {
    const name = names.get(r.id)!;
    const builds: IterationBuild[] = [...pins.get(r.id)!]
      .sort((a, b) => (a.pinnedAt < b.pinnedAt ? -1 : a.pinnedAt > b.pinnedAt ? 1 : a.label < b.label ? -1 : 1))
      .map((p) => {
        const key = `${name}:${p.label}`;
        const named = p.parent === undefined ? undefined : p.parent.includes(":") ? p.parent : `${name}:${p.parent}`;
        const ok = named !== undefined && named !== key && known.has(named);
        return {
          key,
          label: p.label,
          oid: p.oid,
          at: p.pinnedAt,
          note: (p.note.split("\n", 1)[0] ?? "").slice(0, 200),
          parent: ok ? named : null,
          edge: ok ? (p.parent!.includes(":") ? "concept" : "git") : null,
        };
      });
    forks.push({ repo: name, name: r.name, forkOf: r.forkParentId === null ? null : (names.get(r.forkParentId) ?? null), builds });
  }
  // A fork is named by its repository name; its owner joins only when another fork shares that name.
  const clash = (n: string) => forks.filter((f) => f.name === n).length > 1;
  return forks.map((f) => (clash(f.name) ? { ...f, name: f.repo } : f));
}

/**
 * The family as the tree's runs, in drawing order: depth first, and under a
 * run the one that splits off nearest its foot first, so a line never
 * crosses a run. A build continues its parent's run when the parent is that
 * run's last build in the same repository; otherwise it starts a run.
 */
export function lanesOf(forks: readonly IterationFork[]): IterationLane[] {
  type Lane = { -readonly [K in keyof IterationLane]: IterationLane[K] } & { builds: IterationBuild[] };
  const lanes: Lane[] = [];
  const laneOf = new Map<string, Lane>();
  const known = new Set(forks.flatMap((f) => f.builds.map((b) => b.key)));
  for (const f of forks) {
    let main: Lane | undefined;
    const add = (l: Lane) => (lanes.push(l), l);
    for (const b of f.builds) {
      const from = b.parent !== null && known.has(b.parent) ? b.parent : null;
      const at = from === null ? undefined : laneOf.get(from);
      let lane: Lane;
      if (at !== undefined && at.repo === f.repo && at.builds.at(-1)?.key === from) lane = at;
      else if (from === null && main !== undefined) lane = main;
      else if (main === undefined && (at === undefined || at.repo !== f.repo))
        lane = main = add({
          id: f.repo, repo: f.repo, title: f.name, main: true, from,
          fromRepo: from === null ? f.forkOf : null,
          kind: from !== null && b.edge === "concept" ? "concept" : "fork",
          builds: [],
        });
      else
        lane = add({
          id: b.key, repo: f.repo, title: `${f.name} · branch`, main: false, from, fromRepo: null,
          kind: at !== undefined && at.repo === f.repo ? "branch" : b.edge === "concept" ? "concept" : "fork",
          builds: [],
        });
      lane.builds.push(b);
      laneOf.set(b.key, lane);
    }
    if (main === undefined) add({ id: f.repo, repo: f.repo, title: f.name, main: true, from: null, fromRepo: f.forkOf, kind: "fork", builds: [] });
  }
  const childrenOf = (l: Lane) =>
    lanes
      .filter((c) => c !== l && ((c.from !== null && laneOf.get(c.from) === l) || (c.from === null && c.fromRepo === l.repo && l.main)))
      .sort((a, b) => {
        const at = (c: Lane) => (c.from === null ? -1 : l.builds.findIndex((x) => x.key === c.from));
        return at(b) - at(a);
      });
  const out: Lane[] = [];
  const seen = new Set<Lane>();
  const visit = (l: Lane) => {
    if (seen.has(l)) return;
    seen.add(l);
    out.push(l);
    for (const c of childrenOf(l)) visit(c);
  };
  for (const l of lanes) if ((l.from === null || laneOf.get(l.from) === undefined) && (l.fromRepo === null || !lanes.some((x) => x.main && x.repo === l.fromRepo))) visit(l);
  for (const l of lanes) visit(l);
  return out;
}
