/**
 * One word for where a queue row stands (#11619): what /next shows beside its
 * place. Plain data in, a string out. The stage is the flow's (`flow/stage.ts`):
 * an open pull is the work being built, then checked, then in review.
 */
import type { NextRow } from "../../core/next_up.ts";
import type { Stage } from "../../flow/stage.ts";

export interface StateFacts {
  /** The flow's stage for the issue; "issue" when no pull is open on it. */
  readonly stage: Stage;
  /** Open issues it waits for. */
  readonly waits: readonly number[];
  /** A person or the crew is on it. */
  readonly held: boolean;
  readonly onIt: boolean;
}

export function stateWord(_row: NextRow, f: StateFacts): string {
  switch (f.stage) {
    case "pull": return "building";
    case "check": return "checking";
    case "review": return "in review";
    case "land": return "landing";
    case "live": return "live";
    case "issue":
      if (f.waits.length > 0) return `waiting on ${f.waits.slice(0, 3).map((n) => `#${n}`).join(", ")}${f.waits.length > 3 ? ` +${f.waits.length - 3}` : ""}`;
      if (f.held) return "held";
      return f.onIt ? "building" : "ready";
  }
}
