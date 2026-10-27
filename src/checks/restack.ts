/**
 * A red merge batch's re-gate, planned as plain data: the first half on main,
 * then the whole batch stacked on that half. Nothing here touches the queue.
 */

export type Candidate<T> = { pulls: T[]; onto: "main" | "first" };

export type Plan<T> =
  | { kind: "alone"; only: Candidate<T> }
  | { kind: "halves"; first: Candidate<T>; second: Candidate<T> };

export type Outcome<T> = {
  /** Pulls that land now, in queue order. */
  land: T[];
  /** Pulls to plan again, in queue order; empty when nothing waits on a gate. */
  regate: T[];
  /** A pull red on its own, when a single pull was the whole plan. */
  culprit?: T;
};

export function restack<T>(pulls: readonly T[]): Plan<T> {
  if (pulls.length === 0) throw new Error("restack needs at least one pull");
  if (pulls.length === 1) return { kind: "alone", only: { pulls: [...pulls], onto: "main" } };
  const half = Math.ceil(pulls.length / 2);
  return {
    kind: "halves",
    first: { pulls: pulls.slice(0, half), onto: "main" },
    second: { pulls: [...pulls], onto: "first" },
  };
}

/** `secondGreen` is ignored when the first is red (its base never landed) and for a single pull. */
export function afterVerdicts<T>(plan: Plan<T>, firstGreen: boolean, secondGreen: boolean): Outcome<T> {
  if (plan.kind === "alone")
    return firstGreen
      ? { land: [...plan.only.pulls], regate: [] }
      : { land: [], regate: [], culprit: plan.only.pulls[0] as T };
  if (!firstGreen) return { land: [], regate: [...plan.first.pulls] };
  if (secondGreen) return { land: [...plan.second.pulls], regate: [] };
  return {
    land: [...plan.first.pulls],
    regate: plan.second.pulls.slice(plan.first.pulls.length),
  };
}
