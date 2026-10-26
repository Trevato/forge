/**
 * A pull's check, named for a person (#6071): green, red, running or none.
 * Only a run of this very head counts; a cancelled run says nothing.
 */
import type { RunState } from "../core/runs.ts";

export type CheckWord = "green" | "red" | "running" | "none";

export function checkWord(
  run: { state: RunState; commitOid: string } | undefined,
  headOid: string,
): CheckWord {
  if (run === undefined || run.commitOid !== headOid) return "none";
  switch (run.state) {
    case "ok":
      return "green";
    case "failed":
      return "red";
    case "queued":
    case "running":
      return "running";
    default:
      return "none";
  }
}
