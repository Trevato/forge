/**
 * The milestones a wave moved: those above the issues its pulls closed, each
 * with how far along it is now. A milestone is an issue that waits for others
 * (`core/milestones.ts`); the plan's furniture — pillar umbrellas, the Later
 * umbrella and gate — is not one here, by the same rule. Pure: plain data in,
 * plain data out; the caller reads the plan once and the pulls' bodies once.
 */

import type { Database } from "bun:sqlite";
import type { Plan } from "../core/milestones.ts";
import type { Repo } from "../core/repos.ts";
import { mayView } from "../core/sealed.ts";
import type { User } from "../core/users.ts";
import { closesOfMerged } from "./wave_pulls.ts";
import type { PullRef } from "./waves.ts";

export interface MovedMilestone {
  number: number;
  title: string;
  /** Issues beneath it that are done, out of all of them that count, now. */
  done: number;
  total: number;
}

/** The words for how far a milestone is; the page, the card and the API say it alike. */
export const doneWords = (m: Pick<MovedMilestone, "done" | "total">): string => `${m.done} of ${m.total} done`;

/**
 * The one progress line a wave opens with: its widest moved milestone, named
 * with how far it is. Empty when the wave moved none, so no line is drawn.
 */
export function waveProgress(moved: readonly MovedMilestone[]): string {
  let widest: MovedMilestone | undefined;
  for (const m of moved) if (widest === undefined || m.total > widest.total) widest = m;
  return widest === undefined ? "" : `${widest.title}: ${doneWords(widest)}`;
}

/**
 * Which of the wave's pulls (by number) carry each moved milestone: a pull
 * belongs to a milestone that waits, however far up, for an issue it closes.
 */
export function pullsByMilestone(input: {
  pulls: readonly number[];
  closes: ReadonlyMap<number, readonly number[]>;
  plan: Pick<Plan, "read">;
}): Map<number, number[]> {
  const { graph, tree } = input.plan.read;
  const byNumber = new Map(graph.issues.map((i) => [i.number, i.id]));
  const numberOf = new Map(graph.issues.map((i) => [i.id, i.number]));
  const out = new Map<number, number[]>();
  for (const pull of new Set(input.pulls)) {
    const seen = new Set<string>();
    const queue: string[] = [];
    for (const n of input.closes.get(pull) ?? []) {
      const id = byNumber.get(n);
      if (id !== undefined && !seen.has(id)) {
        seen.add(id);
        queue.push(id);
      }
    }
    for (let at = 0; at < queue.length; at++)
      for (const waiter of tree.waitedBy.get(queue[at]!) ?? []) {
        if (seen.has(waiter)) continue;
        seen.add(waiter);
        queue.push(waiter);
        const n = graph.structural.has(waiter) ? undefined : numberOf.get(waiter);
        if (n !== undefined) out.set(n, [...(out.get(n) ?? []), pull]);
      }
  }
  return out;
}

/**
 * `closes` maps a pull's number to the issue numbers it closes; `pulls` names
 * the wave's pulls in this repository. Milestones come back by number.
 */
export function movedMilestones(input: {
  pulls: readonly number[];
  closes: ReadonlyMap<number, readonly number[]>;
  plan: Pick<Plan, "read" | "milestone">;
}): MovedMilestone[] {
  const { graph, tree } = input.plan.read;
  const byNumber = new Map(graph.issues.map((i) => [i.number, i.id]));
  const numberOf = new Map(graph.issues.map((i) => [i.id, i.number]));
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const pull of input.pulls)
    for (const n of input.closes.get(pull) ?? []) {
      const id = byNumber.get(n);
      if (id !== undefined && !seen.has(id)) {
        seen.add(id);
        queue.push(id);
      }
    }
  // Walk up: whatever waits for a closed issue, and for that in turn.
  const above = new Set<string>();
  for (let at = 0; at < queue.length; at++)
    for (const waiter of tree.waitedBy.get(queue[at]!) ?? []) {
      if (seen.has(waiter) || graph.structural.has(waiter)) continue;
      seen.add(waiter);
      above.add(waiter);
      queue.push(waiter);
    }
  const out: MovedMilestone[] = [];
  for (const id of above) {
    const number = numberOf.get(id);
    const milestone = number === undefined ? undefined : input.plan.milestone(number);
    if (number === undefined || milestone === undefined) continue;
    out.push({
      number,
      title: milestone.issue.title,
      done: milestone.weight.done,
      total: milestone.weight.total,
    });
  }
  return out.sort((a, b) => a.number - b.number);
}

/**
 * What both doors show of a wave: the milestones its merged pulls of `repo`
 * moved, leaving out any the viewer may not see. `plan` is read only when a
 * pull closes something, so a wave that closed nothing costs one query.
 */
export function movedForViewer(input: {
  db: Database;
  repo: Repo;
  refs: readonly PullRef[];
  viewer: User | undefined;
  plan: () => Plan;
}): MovedMilestone[] {
  return movedWithPulls(input).map(({ pulls: _pulls, ...m }) => m);
}

/** `movedForViewer`, each milestone with the wave's pulls (numbers) that moved it. */
export function movedWithPulls(input: {
  db: Database;
  repo: Repo;
  refs: readonly PullRef[];
  viewer: User | undefined;
  plan: () => Plan;
}): (MovedMilestone & { pulls: number[] })[] {
  const { db, repo } = input;
  const here = input.refs
    .filter((r) => r.owner === repo.ownerName && r.name === repo.name)
    .map((r) => r.number);
  const closes = closesOfMerged(db, repo, here);
  if ([...closes.values()].every((c) => c.length === 0)) return [];
  const plan = input.plan();
  const issues = new Map(plan.read.graph.issues.map((i) => [i.number, i]));
  const carried = pullsByMilestone({ pulls: here, closes, plan });
  return movedMilestones({ pulls: here, closes, plan })
    .filter((m) => {
      const issue = issues.get(m.number);
      return issue !== undefined && mayView(db, repo, issue, input.viewer);
    })
    .map((m) => ({ ...m, pulls: carried.get(m.number) ?? [] }));
}
