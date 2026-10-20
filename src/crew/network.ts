/**
 * A dropped connection is not the agent's failure. DNS that answers
 * `EAI_AGAIN` for a moment, a reset socket: Claude Code ends such a run
 * with an error and no work, and the same session asked again a few seconds
 * later goes on. The runner retries before it judges the run.
 */

import type { ClaudeOutcome } from "./claude.ts";

const NETWORK =
  /EAI_AGAIN|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EPIPE|fetch failed|socket hang up|can['’]?t reach the API server|unable to connect|connection error/i;

/** Seconds to wait before each retry; its length is the number of retries. */
export const NETWORK_RETRY_SECONDS: readonly number[] = [5, 20, 60];

/** How long a run waits, paused, when the retries found the network still down. */
export const NETWORK_PAUSE_MS = 5 * 60_000;

/** Whether the run ended on the network rather than on the work. */
export function isNetworkError(outcome: ClaudeOutcome): boolean {
  if (outcome.ok) return false;
  return NETWORK.test(outcome.result) || NETWORK.test(outcome.reason);
}

/**
 * Whether a summary is the run's own wording for an outage it retried: it
 * leads with "no changes pushed:" and then names the network. A bare
 * "push failed: ... ECONNREFUSED" is a blocked push and does not match.
 */
export function isOutageSummary(summary: string): boolean {
  return /^\s*no changes pushed:/i.test(summary) && NETWORK.test(summary);
}

/** Resolves after `ms`, or at once when `signal` aborts. */
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done);
  });
}
