/**
 * Why an agent's green pull waits for a person, in words: one place, so the
 * asks, the decision cards, the crew's now list and the MCP cannot say it
 * differently. `paused` is the reviewer seat at 0 (`reviewerPaused`).
 */
import type { ReviewWait } from "./review.ts";

/** The reason alone, without its date. */
export function reviewSays(wait: ReviewWait | undefined, paused: boolean): string {
  if (wait?.why === "rounds") return "the reviewer asked for changes three times";
  if (wait?.why === "lapsed" && paused) return "the reviewer is paused";
  if (wait?.why === "lapsed" && wait.lateCheckMinutes !== undefined)
    return `review ran late: the check took ${wait.lateCheckMinutes} min, and the reviewer did not answer`;
  if (wait?.why === "lapsed") return "the reviewer did not answer";
  return "no reviewer on the crew";
}
