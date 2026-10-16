/**
 * What is wrong with the forge itself, in one sentence, from the guard view
 * and the time. Pure: no reads, no clock. Undefined means nothing to say; a
 * view that was never written (no `checkedAt`) is not stale.
 */

import { GUARD_STALE_MS, rolloutLine, type ForgeHealth, type Guard } from "./guard.ts";

/** Draining longer than this is a release that did not finish. */
export const DRAIN_LIMIT_MS = 5 * 60_000;

export interface VerdictView extends Guard {
  /** When this process began draining (epoch ms), if it has. */
  readonly drainingSince?: number | null;
}

export function forgeVerdict(view: VerdictView, now: number): string | undefined {
  const found = view.incidents.find(
    (i) => i.key === "held" || i.key === "stuck" || i.key.startsWith("oom:"),
  );
  if (found) return `${found.key}: ${found.message}`;
  const since = view.drainingSince;
  if (typeof since === "number" && now - since > DRAIN_LIMIT_MS)
    return `draining for ${Math.floor((now - since) / 60_000)} minutes`;
  if (view.checkedAt !== null && now - Date.parse(view.checkedAt) > GUARD_STALE_MS)
    return `the platform's view is stale: its last check was ${view.checkedAt}`;
  return undefined;
}

/**
 * Whether a strip line says what the verdict already says: the verdict itself,
 * or the rollout line over the same reason. Shown once, not twice.
 */
export function coveredByVerdict(
  line: string,
  verdict: string | undefined,
  h: ForgeHealth,
): boolean {
  if (verdict === undefined) return false;
  if (line === verdict) return true;
  return (
    line === rolloutLine(h) &&
    h.rollout.reason !== "" &&
    verdict.includes(h.rollout.reason)
  );
}

/** The verdict as the strip's first line. */
export function verdictLine(verdict: string): string {
  return `needs you: forge ${verdict}`;
}
