/**
 * What an ask row waits for, in one word, and on whom. One pure function so
 * `/asks` and the MCP `asks` tool can never say two things about one row.
 */

export type WaitWord =
  | "ready to land"
  | "conflicts with main"
  | "a decision"
  | "a review"
  | "assigned to you";

export interface WaitingFor {
  readonly word: WaitWord;
  /** Who it waits on: "you", or the name of whoever has to move first. */
  readonly on: string;
}

export interface WaitFacts {
  /** The ask's kind (`DecisionKind`). */
  readonly kind: "stopped" | "look" | "review" | "paused" | "parked" | "declined" | "handover" | "assigned" | "proposal";
  /** Files stopping the pull from merging, as the last sweep found it. */
  readonly conflicts: number;
  /** Whether the pull or issue the ask is about is assigned to the viewer. */
  readonly assignedToViewer: boolean;
  /** Whoever wrote the change (the crew's name for an ask with no author). */
  readonly who: string;
}

/**
 * A change that cannot merge waits on its author; a green one is ready for
 * the viewer to land; a review or a handover waits for a review; a thing
 * assigned to the viewer says so; every other ask is a decision.
 */
export function waitingFor(f: WaitFacts): WaitingFor {
  if (f.conflicts > 0) return { word: "conflicts with main", on: f.who };
  if (f.kind === "look") return { word: "ready to land", on: "you" };
  if (f.kind === "review" || f.kind === "handover")
    return { word: "a review", on: "you" };
  if (f.assignedToViewer) return { word: "assigned to you", on: "you" };
  return { word: "a decision", on: "you" };
}
