/**
 * The order of the limbs (#1064): which of a milestone's limbs comes first,
 * set by a person, and the crew's ready order that follows it.
 *
 * `limbTree` reads the shape once from a graph: what each issue waits for
 * with the plan's furniture left out, the top of the plan, and which
 * children are limbs (they bring a tree of their own) rather than leaves.
 * A person's places are stored per group of siblings — `TOP` for the top of
 * the plan, else the issue whose limbs they are — and a limb with no place
 * of its own follows the placed ones, by number. `limbRanks` walks the
 * ordered tree once: an issue's rank is the first limb that holds it, so one
 * beneath two limbs takes the higher. Nothing here queries per issue.
 */

import type { Database } from "bun:sqlite";
import type { Graph } from "./dependencies.ts";
import type { Issue } from "./issues.ts";
import { isStructural, type Pillars } from "./pillars.ts";

/** The group of siblings at the top of the plan. */
export const TOP = "";

/** Stored places: group → limb → place (1 is first). */
export type Places = ReadonlyMap<string, ReadonlyMap<string, number>>;

export interface LimbTree {
  /** Every issue that waits for something beyond the furniture, and what for. */
  readonly waitsFor: ReadonlyMap<string, readonly string[]>;
  readonly waitedBy: ReadonlyMap<string, readonly string[]>;
  /** Issues that wait for anything at all, the furniture included. */
  readonly waits: ReadonlySet<string>;
  /** The top-level limbs in their natural order: the pillars and Later, or the plan's roots. */
  readonly top: readonly Issue[];
  /** What an issue waits for directly, as its milestone shows it. */
  childrenOf(id: string): readonly string[];
  /** The children that bring a tree of their own, by number. */
  limbsOf(id: string): readonly string[];
  /** Every issue that has children. */
  parents(): readonly string[];
}

export function limbTree(
  graph: Pick<Graph, "issues" | "edges">,
  set: Pillars,
): LimbTree {
  const byId = new Map(graph.issues.map((i) => [i.id, i]));
  const waitsFor = new Map<string, string[]>();
  const waitedBy = new Map<string, string[]>();
  const waits = new Set<string>();
  for (const edge of graph.edges) {
    waits.add(edge.issueId);
    if (isStructural(set, edge.blockedById)) continue;
    waitsFor.set(edge.issueId, [
      ...(waitsFor.get(edge.issueId) ?? []),
      edge.blockedById,
    ]);
    waitedBy.set(edge.blockedById, [
      ...(waitedBy.get(edge.blockedById) ?? []),
      edge.issueId,
    ]);
  }
  // Work behind the gate is Later's whether or not the Later umbrella waits
  // for it: its milestone counts what the map's Later row counts.
  const behindGate =
    set.gate === undefined
      ? []
      : graph.edges
          .filter(
            (e) =>
              e.blockedById === set.gate!.id && !isStructural(set, e.issueId),
          )
          .map((e) => e.issueId);
  if (set.later !== undefined && behindGate.length > 0) waits.add(set.later.id);
  const childrenOf = (id: string): readonly string[] =>
    id === set.later?.id
      ? [...new Set([...(waitsFor.get(id) ?? []), ...behindGate])]
      : (waitsFor.get(id) ?? []);
  const top: Issue[] =
    set.pillars.length > 0
      ? [
          ...set.pillars.map((p) => p.umbrella),
          ...(set.later === undefined ? [] : [set.later]),
        ]
      : graph.issues.filter(
          (i) =>
            i.state === "open" &&
            childrenOf(i.id).length > 0 &&
            !(waitedBy.get(i.id) ?? []).some(
              (id) => byId.get(id)?.state === "open",
            ),
        );
  const parents = [
    ...new Set([
      ...waitsFor.keys(),
      ...(set.later !== undefined && behindGate.length > 0 ? [set.later.id] : []),
    ]),
  ];
  return {
    waitsFor,
    waitedBy,
    waits,
    top,
    childrenOf,
    parents: () => parents,
    limbsOf(id) {
      const children = childrenOf(id)
        .map((c) => byId.get(c))
        .filter((i): i is Issue => i !== undefined)
        .sort((a, b) => a.number - b.number);
      // A child is a limb when it brings a tree of its own; one that only
      // waits for its siblings is a leaf in an order.
      const siblings = new Set(children.map((c) => c.id));
      return children
        .filter((c) => (waitsFor.get(c.id) ?? []).some((w) => !siblings.has(w)))
        .map((c) => c.id);
    },
  };
}

/** Every stored place of one repository, in one read. */
export function readPlaces(db: Database, repoId: string): Places {
  const out = new Map<string, Map<string, number>>();
  for (const row of db
    .query<{ parent_id: string; issue_id: string; place: number }, [string]>(
      `SELECT parent_id, issue_id, place FROM limb_place WHERE repo_id = ?1`,
    )
    .all(repoId)) {
    const group = out.get(row.parent_id) ?? new Map<string, number>();
    group.set(row.issue_id, row.place);
    out.set(row.parent_id, group);
  }
  return out;
}

/** One group of siblings in order: the placed ones by place, then the rest as they came. */
export function seated(
  places: Places,
  group: string,
  ids: readonly string[],
): string[] {
  const mine = places.get(group);
  if (mine === undefined) return [...ids];
  const at = (id: string) => mine.get(id);
  const placed = ids
    .filter((id) => at(id) !== undefined)
    .sort((a, b) => at(a)! - at(b)!);
  return [...placed, ...ids.filter((id) => at(id) === undefined)];
}

/** Every group that has limbs, each in order. */
export function groupsOf(tree: LimbTree, places: Places): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const top = tree.top.map((i) => i.id);
  if (top.length > 0) out.set(TOP, seated(places, TOP, top));
  for (const id of tree.parents()) {
    const limbs = tree.limbsOf(id);
    if (limbs.length > 0) out.set(id, seated(places, id, limbs));
  }
  return out;
}

/**
 * Each issue's rank: the first limb, in the order of the limbs, that holds
 * it. A lower rank is higher. Issues beneath no limb have none.
 */
export function limbRanks(tree: LimbTree, places: Places): Map<string, number> {
  const rank = new Map<string, number>();
  const seen = new Set<string>();
  let next = 0;
  const visit = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const n = next++;
    if (!rank.has(id)) rank.set(id, n);
    for (const child of tree.childrenOf(id)) if (!rank.has(child)) rank.set(child, n);
    for (const limb of seated(places, id, tree.limbsOf(id))) visit(limb);
  };
  for (const id of seated(places, TOP, tree.top.map((i) => i.id))) visit(id);
  return rank;
}

/** The places with one group set to this order, 1 for the first. */
export function withGroup(
  places: Places,
  group: string,
  ids: readonly string[],
): Places {
  const next = new Map(places);
  next.set(group, new Map(ids.map((id, n) => [id, n + 1])));
  return next;
}

/** Keep one group's order. */
export function savePlaces(
  db: Database,
  repoId: string,
  group: string,
  ids: readonly string[],
): void {
  db.transaction(() => {
    db.query(`DELETE FROM limb_place WHERE repo_id = ?1 AND parent_id = ?2`).run(
      repoId,
      group,
    );
    ids.forEach((id, n) =>
      db
        .query(
          `INSERT INTO limb_place (repo_id, parent_id, issue_id, place) VALUES (?1, ?2, ?3, ?4)`,
        )
        .run(repoId, group, id, n + 1),
    );
  })();
}
