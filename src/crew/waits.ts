/**
 * Why an approved pull has not landed (#3055): the reason the green sweep's
 * `admit` gave each one, counted per repository, so the tick line says how
 * many approved pulls wait and on what. An approved pull that sits still
 * is then never a mystery: "stale" is a check the queue has asked for
 * again on the moved base, "queued" is a pull in the merge queue's line.
 */

/** Why a pull did not join the merge queue on this sweep, or that it did. */
export type Wait =
  | "queued"
  | "off"
  | "closed"
  | "held"
  | "outsider"
  | "unchecked"
  | "not-green"
  | "stopped"
  | "conflict"
  | "carried"
  | "wall"
  | "review"
  | "red"
  | "stale";

/** How many approved pulls waited on each reason. */
export type Waits = Partial<Record<Wait, number>>;

export function tallyWaits(waits: readonly Wait[]): Waits {
  const out: Waits = {};
  for (const w of waits) out[w] = (out[w] ?? 0) + 1;
  return out;
}

/** `2 approved: queued=1 stale=1`, most first; undefined when none waited. */
export function waitWords(waits: Waits): string | undefined {
  const said = (Object.entries(waits) as [Wait, number][])
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (said.length === 0) return undefined;
  const total = said.reduce((n, [, k]) => n + k, 0);
  return `${total} approved: ${said.map(([w, n]) => `${w}=${n}`).join(" ")}`;
}

/** The last finished sweep's tally, by repository id: the sweep runs beside the tick. */
const last = new Map<string, Waits>();

export function noteWaits(repoId: string, waits: Waits): void {
  last.set(repoId, waits);
}

export function lastWaits(repoId: string): Waits {
  return last.get(repoId) ?? {};
}
