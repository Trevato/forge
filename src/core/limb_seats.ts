/**
 * A limb's seat (#1064): its place among its siblings, as a fleet row holds
 * it. A seat is `<group>:<place>`, the group being `top` or the number of
 * the issue whose limbs these are, the place counted from 1. A limb that is
 * a limb of several issues holds one seat in each. Moving a limb rewrites
 * its group's order whole, so the fleet's undo — the seat from before — puts
 * the others back with it.
 */

import { repoGraph, type Graph } from "./dependencies.ts";
import type { Database } from "bun:sqlite";
import {
  groupsOf,
  limbTree,
  type LimbTree,
  readPlaces,
  savePlaces,
  TOP,
  type Places,
} from "./limb_order.ts";
import { pillarsOf } from "./pillars.ts";
import type { Repo } from "./repos.ts";

export interface Seating {
  /** The seats an issue holds, `top` first, then by the number of the group. */
  of(issueId: string): readonly string[];
  /** How many limbs sit in a group (`top` or an issue number). */
  size(group: string): number;
  /** A group's limbs, in order, as issue ids. */
  order(group: string): readonly string[];
  /** The id of the issue a group names. */
  parentId(group: string): string | undefined;
  readonly places: Places;
  /** What it was read from, for a caller that asks more of the same graph. */
  readonly graph: Graph;
  readonly tree: LimbTree;
}

const SEAT = /^(top|[1-9][0-9]{0,8}):([1-9][0-9]{0,5})$/;

/** A seat's group and place, or nothing when it is not one. */
export function parseSeat(
  value: unknown,
): { group: string; place: number } | undefined {
  const m = typeof value === "string" ? SEAT.exec(value) : null;
  return m === null ? undefined : { group: m[1]!, place: Number(m[2]) };
}

export function seating(
  db: Database,
  repo: Repo,
  read?: { graph: Graph; tree: LimbTree; places: Places },
): Seating {
  const graph = read?.graph ?? repoGraph(db, repo.id);
  const tree = read?.tree ?? limbTree(graph, pillarsOf(db, repo));
  const places = read?.places ?? readPlaces(db, repo.id);
  const groups = groupsOf(tree, places);
  const numberOf = new Map(graph.issues.map((i) => [i.id, i.number]));
  const idOf = new Map(graph.issues.map((i) => [String(i.number), i.id]));
  const name = (id: string): string =>
    id === TOP ? "top" : String(numberOf.get(id) ?? 0);
  const keys = [...groups.keys()].sort((a, b) =>
    a === TOP ? -1 : b === TOP ? 1 : (numberOf.get(a) ?? 0) - (numberOf.get(b) ?? 0),
  );
  const held = new Map<string, string[]>();
  for (const key of keys)
    groups.get(key)!.forEach((id, n) =>
      held.set(id, [...(held.get(id) ?? []), `${name(key)}:${n + 1}`]),
    );
  const keyOf = (group: string): string =>
    group === "top" ? TOP : (idOf.get(group) ?? "\0");
  return {
    of: (id) => held.get(id) ?? [],
    size: (group) => groups.get(keyOf(group))?.length ?? 0,
    order: (group) => groups.get(keyOf(group)) ?? [],
    parentId: (group) => (group === "top" ? TOP : idOf.get(group)),
    places,
    graph,
    tree,
  };
}

/** Seat a limb at a place in its group; undefined when it sits there, else why not. */
export function moveLimb(
  db: Database,
  repo: Repo,
  issueId: string,
  seat: { group: string; place: number },
): string | undefined {
  const seats = seating(db, repo);
  const ids = [...seats.order(seat.group)];
  const at = ids.indexOf(issueId);
  if (at < 0) return "it is not one of those limbs";
  if (seat.place > ids.length) return `there are only ${ids.length} limbs there`;
  ids.splice(at, 1);
  ids.splice(seat.place - 1, 0, issueId);
  const group = seats.parentId(seat.group)!;
  // Back where it began is no order at all: the rows go, and the crew's
  // ready order is the natural one again.
  const natural = group === TOP ? seats.tree.top.map((i) => i.id) : seats.tree.limbsOf(group);
  const same = ids.length === natural.length && ids.every((id, n) => id === natural[n]);
  savePlaces(db, repo.id, group, same ? [] : ids);
  return undefined;
}
