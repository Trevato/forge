/**
 * A fork family's build pins as data: the builds (`buildOf`) with what a
 * page, the terminal and the API draw from them, grouped as fork cards
 * (`iterationsOf`) and as the tree's runs (`lanesOf`). What a repository
 * holds is read from git once and kept briefly (`ttl_cache.ts`); a build's
 * refs are read per build, so they are kept too.
 */

import { getAppByRepo } from "./apps.ts";
import { buildLineage, familyRepos, type Viewing } from "./lineage.ts";
import { canWrite, getRepo, type Repo } from "./repos.ts";
import { remembered } from "./ttl_cache.ts";
import { listBranches } from "../git/branches.ts";
import { refsContaining, splitPinNote, wholeNotes, type BuildNote, type BuildPin } from "../git/builds.ts";
import { repoDir } from "../git/repos.ts";
import { isMirror } from "../origins/write-through.ts";

/** How a build plays: a build preview of its commit, or nothing for a repository that is no app. */
export type Plays = "env" | "none";

/** One build, as its row, player and info panel draw it. */
export interface IterationBuild {
  readonly key: string;
  readonly repo: string;
  readonly label: string;
  readonly oid: string;
  /** Branches whose tip is this commit, else the branch it was pinned from. */
  readonly branch: string;
  readonly at: string;
  readonly by: string;
  /** Its first note's first line, else its tag message's: the one-line summary; empty when it is only the label. */
  readonly note: string;
  /** Its notes, ranked: people's first (`git/builds.ts`). */
  readonly notes: readonly BuildNote[];
  /** Its tag message's note, whole; empty when it is only the label. */
  readonly tag: string;
  /** What a fork of its repository carries of its commit: a branch that holds it, else whether a tag does. */
  readonly forkHas: { readonly branch: string | null; readonly tagged: boolean };
  /** The pin it hangs from and how: `owner/name:label`. */
  readonly parent: string | null;
  readonly edge: "git" | "concept" | null;
  readonly plays: Plays;
  readonly page: string;
  /** Whether its build preview may be opened: a person who writes an app. */
  readonly preview: boolean;
  /** Whether its notes may be edited: a person who writes its repository, not a mirror. */
  readonly canNote: boolean;
}

const BRANCH_LIMIT = 30;
/** What every build of one repository is drawn from, read once. */
export interface RepoFacts {
  readonly repo: Repo;
  /** `owner/name`. */
  readonly name: string;
  readonly dir: string;
  /** Its branches, up to `BRANCH_LIMIT`; none when not asked for. */
  readonly branches: readonly { readonly name: string; readonly oid: string }[];
  readonly isApp: boolean;
  /** Whether the viewer is a person who writes it. */
  readonly writer: boolean;
}

/** `r`'s facts as `ctx`'s viewer sees them; its branches only when `withBranches`. */
export async function repoFactsOf(ctx: Viewing, r: Repo, withBranches: boolean): Promise<RepoFacts> {
  const dir = repoDir(ctx.app.reposRoot, r.ownerName, r.name);
  const listed = withBranches ? await remembered(ctx.app, `branches:${r.id}`, () => listBranches(dir, r.defaultBranch)) : undefined;
  const user = ctx.auth.user;
  return {
    repo: r,
    name: `${r.ownerName}/${r.name}`,
    dir,
    branches: listed?.ok ? listed.value.branches.slice(0, BRANCH_LIMIT) : [],
    isApp: getAppByRepo(ctx.app.db, r.id) !== undefined,
    writer: user !== undefined && user.kind !== "agent" && canWrite(ctx.app.db, r, user),
  };
}

/** One pin, as its row, player and info panel draw it. */
export async function buildOf(
  ctx: Viewing,
  rf: RepoFacts,
  pin: BuildPin,
  parent: string | null,
  edge: "git" | "concept" | null,
): Promise<IterationBuild> {
  const { repo: r, name, dir } = rf;
  const plays: Plays = rf.isApp ? "env" : "none";
  const at = rf.branches.filter((b) => b.oid === pin.oid).map((b) => b.name);
  const from = /^branch (.+)$/.exec(pin.source)?.[1];
  // A branch at the commit first, then the default branch, then any branch that holds it.
  const holds = await remembered(ctx.app, `refs:${r.id}:${pin.oid}`, () => refsContaining(dir, pin.oid));
  const onBranch = at[0] ?? (holds.branches.includes(r.defaultBranch) ? r.defaultBranch : holds.branches[0]) ?? null;
  return {
    key: `${name}:${pin.label}`,
    repo: name,
    label: pin.label,
    oid: pin.oid,
    branch: at.length > 0 ? at.join(", ") : (from ?? ""),
    at: pin.pinnedAt,
    by: pin.pinnedBy,
    note: splitPinNote(pin.label, pin.note).note,
    notes: pin.notes ?? [],
    tag: wholeNotes(pin.label, pin.tagNote ?? pin.note),
    forkHas: { branch: onBranch, tagged: holds.tags.length > 0 },
    parent,
    edge,
    plays,
    page: "/",
    preview: plays === "env" && rf.writer,
    canNote: rf.writer && !isMirror(ctx.app, r),
  };
}

/** One fork's card. */
export interface IterationFork {
  readonly repo: string;
  readonly name: string;
  /** Its column: fork depth, a concept edge counting as one more step. */
  readonly depth: number;
  /** The repository it was forked from, when that is in the family. */
  readonly forkOf: string | null;
  /** Its builds, oldest first. */
  readonly builds: readonly IterationBuild[];
  /** Branches with no pin at their tip. */
  readonly tips: readonly string[];
}

export interface IterationEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: "fork" | "concept";
}

export interface Iterations {
  readonly forks: readonly IterationFork[];
  readonly edges: readonly IterationEdge[];
}

/**
 * One column of the downward tree (records/design/1101-forgej-graph-layout,
 * B): a fork's main run, or a run that splits off a build. Its builds run
 * top to bottom; it hangs under the build it grew from.
 */
export interface IterationLane {
  /** The fork's repository for its main run, else the key of the run's first build. */
  readonly id: string;
  readonly repo: string;
  readonly title: string;
  readonly main: boolean;
  /** The build it grew from, `owner/name:label`; null for a root. */
  readonly from: string | null;
  /** For a main run with no build to hang from, the repository it was forked from. */
  readonly fromRepo: string | null;
  readonly kind: "fork" | "branch" | "concept" | null;
  readonly builds: readonly IterationBuild[];
  readonly tips: readonly string[];
}

/**
 * The family as the downward tree's runs, in the order the tree draws them:
 * depth first, and under each run the one that splits off nearest its foot
 * first, so a line never crosses a run. A build continues its parent's run
 * when the parent is that run's last build in the same repository;
 * otherwise it starts a run of its own.
 */
export function lanesOf(forks: readonly IterationFork[]): IterationLane[] {
  type Lane = { id: string; repo: string; title: string; main: boolean; from: string | null; fromRepo: string | null; kind: IterationLane["kind"]; builds: IterationBuild[]; tips: readonly string[] };
  const lanes: Lane[] = [];
  const laneOf = new Map<string, Lane>();
  const known = new Set(forks.flatMap((f) => f.builds.map((b) => b.key)));
  for (const f of [...forks].sort((a, b) => a.depth - b.depth)) {
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
          id: f.repo,
          repo: f.repo,
          title: f.name,
          main: true,
          from,
          fromRepo: from === null ? f.forkOf : null,
          kind: from === null ? (f.forkOf === null ? null : "fork") : b.edge === "concept" ? "concept" : "fork",
          builds: [],
          tips: f.tips,
        });
      else
        lane = add({
          id: b.key,
          repo: f.repo,
          title: `${f.name} · branch`,
          main: false,
          from,
          fromRepo: null,
          kind: at !== undefined && at.repo === f.repo ? "branch" : b.edge === "concept" ? "concept" : "fork",
          builds: [],
          tips: [],
        });
      lane.builds.push(b);
      laneOf.set(b.key, lane);
    }
    if (main === undefined)
      add({ id: f.repo, repo: f.repo, title: f.name, main: true, from: null, fromRepo: f.forkOf, kind: f.forkOf === null ? null : "fork", builds: [], tips: f.tips });
  }
  // Depth first from the roots; under a run, the child that starts lowest comes first.
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

/** The family's pins as fork cards and the lines between them; undefined when it holds no pin. */
export async function iterationsOf(ctx: Viewing, repo: Repo): Promise<Iterations | undefined> {
  const here = `${repo.ownerName}/${repo.name}`;
  const lineage = await buildLineage(ctx, repo);
  if (lineage.length === 0) return undefined;
  const family = familyRepos(ctx, repo);
  const byName = new Map(family.map((r) => [`${r.ownerName}/${r.name}`, r]));
  const byId = new Map(family.map((r) => [r.id, r]));
  // A concept edge may name a pin outside the family: its repository is a card too.
  const outside: Repo[] = [];
  for (const n of lineage) {
    const name = n.from ?? here;
    if (byName.has(name)) continue;
    const [owner = "", rname = ""] = name.split("/");
    const r = getRepo(ctx.app.db, owner, rname);
    if (r === undefined) continue;
    byName.set(name, r);
    outside.push(r);
  }
  const forks: IterationFork[] = [];
  for (const r of [...outside, ...family]) {
    const name = `${r.ownerName}/${r.name}`;
    const own = lineage.filter((n) => (n.from ?? here) === name).sort((a, b) => (a.pin.pinnedAt < b.pin.pinnedAt ? -1 : 1));
    const rf = await repoFactsOf(ctx, r, byId.has(r.id));
    const branches = rf.branches;
    const builds: IterationBuild[] = [];
    for (const n of own) builds.push(await buildOf(ctx, rf, n.pin, n.parent ?? null, n.edge ?? null));
    const pinned = new Set(own.map((n) => n.pin.oid));
    const parent = r.forkParentId === null ? undefined : byId.get(r.forkParentId);
    forks.push({
      repo: name,
      name: r.name,
      depth: 0,
      forkOf: parent === undefined ? null : `${parent.ownerName}/${parent.name}`,
      builds,
      // Branches with no build pinned, beside the builds a fork has; never its default branch.
      tips: own.length === 0 ? [] : branches.filter((b) => !pinned.has(b.oid) && b.name !== r.defaultBranch).map((b) => b.name),
    });
  }

  // Fork lines, then a dashed line where a pin names a pin in another repository.
  const edges: IterationEdge[] = [];
  for (const f of forks) if (f.forkOf !== null) edges.push({ from: f.forkOf, to: f.repo, kind: "fork" });
  for (const f of forks)
    for (const b of f.builds) {
      if (b.edge !== "concept" || b.parent === null) continue;
      const from = b.parent.slice(0, b.parent.lastIndexOf(":"));
      if (from !== f.repo && byName.has(from) && !edges.some((e) => e.kind === "concept" && e.from === from && e.to === f.repo))
        edges.push({ from, to: f.repo, kind: "concept" });
    }
  // Columns: each card one step right of every card it hangs from. Bounded, so a cycle ends.
  const depth = new Map(forks.map((f) => [f.repo, 0]));
  for (let i = 0; i < forks.length; i++)
    for (const e of edges) {
      const d = (depth.get(e.from) ?? 0) + 1;
      if (d > (depth.get(e.to) ?? 0) && d < forks.length) depth.set(e.to, d);
    }
  // A fork is named by its repository name; its owner joins only when another fork shares that name.
  const clash = (n: string) => forks.filter((f) => f.name === n).length > 1;
  return { forks: forks.map((f) => ({ ...f, name: clash(f.name) ? f.repo : f.name, depth: depth.get(f.repo) ?? 0 })), edges };
}
