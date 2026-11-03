/**
 * The fork family a viewer may read and its pins as a lineage: a pin's
 * parent is the one its person named, else the nearest pin in its history —
 * read from git (`for-each-ref --merged`), so the tree follows the work even
 * across merges and squashes that a strict commit graph would split. A
 * fork's first pins hang from its parent repository's, which its objects
 * share. A repository's pins are kept briefly (`ttl_cache.ts`).
 */

import { canRead, getRepo, getRepoById, visibleForks, type Repo } from "./repos.ts";
import { remembered } from "./ttl_cache.ts";
import type { User } from "./users.ts";
import { isAncestor, isCopiedPin, listBuildPins, pinsMergedInto, type BuildPin } from "../git/builds.ts";
import { repoDir } from "../git/repos.ts";
import type { Ctx } from "../http/context.ts";

/** Who is looking, and on what: a page's `Ctx`, or the terminal's session. */
export type Viewing = Pick<Ctx, "app"> & { readonly auth: { readonly user: User | undefined } };

/** One pin in the tree: where it hangs and how deep. */
export interface BuildNode {
  readonly pin: BuildPin;
  /** The repository it lives in, `owner/name`, when not this one. */
  readonly from: string | undefined;
  /** Its parent's key, `owner/name:label`. */
  readonly parent: string | undefined;
  /** How it hangs: by history (`git`) or by a person's concept edge. */
  readonly edge: "git" | "concept" | undefined;
  readonly depth: number;
}

/** One repository of the family, read once. */
interface Member {
  readonly repo: Repo;
  readonly name: string;
  readonly dir: string;
  readonly pins: BuildPin[];
  /** Per pin label: the labels of this repository's pins its commit contains. */
  readonly merged: Map<string, Set<string>>;
}

/** How many repositories a family view reads. */
export const FAMILY_LIMIT = 40;

function member(ctx: Viewing, repo: Repo): Promise<Member> {
  const dir = repoDir(ctx.app.reposRoot, repo.ownerName, repo.name);
  return remembered(ctx.app, `member:${repo.id}`, async () => {
    const pins = await listBuildPins(dir);
    const merged = new Map(await Promise.all(pins.map(async (p) => [p.label, await pinsMergedInto(dir, p.oid)] as const)));
    return { repo, name: `${repo.ownerName}/${repo.name}`, dir, pins, merged };
  });
}

/** The nearest of `found` in `m`: the one whose commit contains most of them. */
function nearestOf(m: Member, found: readonly BuildPin[]): BuildPin | undefined {
  const reach = (p: BuildPin) => found.filter((q) => m.merged.get(p.label)?.has(q.label)).length;
  return [...found].sort(
    (a, b) => reach(b) - reach(a) || (a.pinnedAt < b.pinnedAt ? 1 : -1),
  )[0];
}

/** The fork family the viewer may read: up to the root, then every fork below it, root first. */
export function familyRepos(ctx: Viewing, repo: Repo): Repo[] {
  const db = ctx.app.db;
  const viewer = ctx.auth.user;
  let root = repo;
  for (let i = 0; i < FAMILY_LIMIT && root.forkParentId !== null; i++) {
    const up = getRepoById(db, root.forkParentId);
    if (up === undefined || !canRead(db, up, viewer)) break;
    root = up;
  }
  const repos: Repo[] = [root];
  for (let i = 0; i < repos.length && repos.length < FAMILY_LIMIT; i++)
    repos.push(...visibleForks(db, repos[i]!.id, viewer).slice(0, FAMILY_LIMIT - repos.length));
  return repos;
}

/**
 * The whole family's pins as one forest: this repository, the forks above
 * it to the root, and every fork below the root that the viewer may read.
 * A pin hangs under the parent its person named — here, or in another
 * repository by a concept edge — else under the nearest pin in its own
 * repository's history, else under the nearest pin in the history of the
 * repositories it was forked from, nearest first.
 */
export async function buildLineage(ctx: Viewing, repo: Repo): Promise<BuildNode[]> {
  const db = ctx.app.db;
  const viewer = ctx.auth.user;
  const repos = familyRepos(ctx, repo);
  const members = new Map<string, Member>();
  for (const m of await Promise.all(repos.map((r) => member(ctx, r)))) members.set(m.name, m);
  // A fork carries its parent's pins; the family draws each once, in the parent.
  const byId = new Map([...members.values()].map((m) => [m.repo.id, m]));
  for (const m of [...members.values()]) {
    const up = m.repo.forkParentId === null ? undefined : byId.get(m.repo.forkParentId);
    if (up !== undefined) members.set(m.name, { ...m, pins: m.pins.filter((p) => !isCopiedPin(p, up.pins)) });
  }
  if ([...members.values()].every((m) => m.pins.length === 0)) return [];

  // A concept edge may reach outside the family: that repository's pin is
  // drawn as the root it hangs from.
  for (const m of [...members.values()])
    for (const p of m.pins) {
      const at = p.parent?.lastIndexOf(":") ?? -1;
      if (at === -1) continue;
      const [owner = "", name = ""] = p.parent!.slice(0, at).split("/");
      const key = `${owner}/${name}`;
      if (members.has(key) || members.size >= FAMILY_LIMIT) continue;
      const other = getRepo(db, owner, name);
      if (other === undefined || !canRead(db, other, viewer)) continue;
      const full = await member(ctx, other);
      const wanted = full.pins.filter((q) => q.label === p.parent!.slice(at + 1));
      members.set(key, { ...full, pins: wanted });
    }

  const keyOf = (m: Member, label: string) => `${m.name}:${label}`;
  const nodes: {
    pin: BuildPin;
    m: Member;
    parent: string | undefined;
    edge: "git" | "concept" | undefined;
  }[] = [];
  const known = new Set<string>();
  for (const m of members.values()) for (const p of m.pins) known.add(keyOf(m, p.label));

  for (const m of members.values())
    for (const pin of m.pins) {
      const self = keyOf(m, pin.label);
      // 1. The parent its person named.
      if (pin.parent !== undefined) {
        const named = pin.parent.includes(":") ? pin.parent : keyOf(m, pin.parent);
        if (named !== self && known.has(named)) {
          nodes.push({ pin, m, parent: named, edge: pin.parent.includes(":") ? "concept" : "git" });
          continue;
        }
      }
      // 2. The nearest pin in its own history. A pin on the same commit
      //    made later is its child, never its parent.
      const own = m.merged.get(pin.label) ?? new Set<string>();
      const near = nearestOf(
        m,
        m.pins.filter(
          (p) => p.label !== pin.label && own.has(p.label) && !(p.oid === pin.oid && p.pinnedAt >= pin.pinnedAt),
        ),
      );
      if (near !== undefined) {
        nodes.push({ pin, m, parent: keyOf(m, near.label), edge: "git" });
        continue;
      }
      // 3. The nearest pin of the repositories it was forked from: a fork
      //    shares their objects, so git can say what its history holds.
      let hung: string | undefined;
      let up = m.repo.forkParentId === null ? undefined : getRepoById(db, m.repo.forkParentId);
      for (let i = 0; up !== undefined && i < FAMILY_LIMIT && hung === undefined; i++) {
        const um = members.get(`${up.ownerName}/${up.name}`);
        if (um !== undefined) {
          const found: BuildPin[] = [];
          for (const p of um.pins) if (await isAncestor(m.dir, p.oid, pin.oid)) found.push(p);
          const best = nearestOf(um, found);
          if (best !== undefined) hung = keyOf(um, best.label);
        }
        up = up.forkParentId === null ? undefined : getRepoById(db, up.forkParentId);
      }
      nodes.push({ pin, m, parent: hung, edge: hung === undefined ? undefined : "git" });
    }

  // Children under parents, oldest first at every level.
  const children = new Map<string | undefined, typeof nodes>();
  for (const n of nodes) {
    const list = children.get(n.parent) ?? [];
    list.push(n);
    children.set(n.parent, list);
  }
  const here = `${repo.ownerName}/${repo.name}`;
  const out: BuildNode[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | undefined, depth: number) => {
    const list = (children.get(parent) ?? []).sort((a, b) => (a.pin.pinnedAt < b.pin.pinnedAt ? -1 : 1));
    for (const n of list) {
      const key = keyOf(n.m, n.pin.label);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        pin: n.pin,
        from: n.m.name === here ? undefined : n.m.name,
        parent: n.parent,
        edge: n.edge,
        depth,
      });
      walk(key, depth + 1);
    }
  };
  walk(undefined, 0);
  return out;
}
