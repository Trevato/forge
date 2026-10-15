/**
 * Which stage of the one flow an issue is in, and for how long.
 *
 * issue → pull → check → review → land → live. Pure: plain records in, a
 * plain answer out, the clock passed in. Reading the records is `read.ts`.
 *
 * The rules, in one place:
 * - A pull that was closed without merging is not in the flow; the issue is
 *   back at `issue`, since the close. A closed pull that was re-opened is an
 *   open pull again, since the re-open (`openedAt`).
 * - With several open pulls the furthest along speaks for the issue.
 * - A merged pull is `land` until production has served it, then `live`.
 * - `stalled` is true once `since` is older than the stage's threshold.
 */

export const STAGES = ["issue", "pull", "check", "review", "land", "live"] as const;
export type Stage = (typeof STAGES)[number];

/** How long a stage may take before it is called stalled, in minutes. `live` is never stalled. */
export const STALL_MINUTES: Readonly<Record<Stage, number>> = {
  issue: 24 * 60,
  pull: 60,
  check: 30,
  review: 12 * 60,
  land: 120,
  live: Number.POSITIVE_INFINITY,
};

/** The checks at a pull's current head, folded. */
export interface FlowChecks {
  /** `none` when no check has been asked for at this head. */
  readonly state: "none" | "running" | "failed" | "ok";
  /** When it entered that state (queued, or finished); null for none. */
  readonly at: string | null;
}

export interface FlowPull {
  readonly number: number;
  readonly state: "open" | "closed";
  /** Created, or last re-opened. */
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly mergedAt: string | null;
  readonly checks: FlowChecks;
  readonly approvals: number;
  readonly changesRequested: number;
  /** Whether the repository asks for an approval before a merge. */
  readonly requireReview: boolean;
  /** When the latest verdict at this head was passed. */
  readonly reviewedAt: string | null;
  /** When production finished serving the merge; null while it has not. */
  readonly liveAt: string | null;
  /** The newest production deploy failed after the merge. */
  readonly deployFailed: boolean;
}

export interface FlowIssue {
  readonly number: number;
  readonly title: string;
  readonly createdAt: string;
  readonly assignee: string | null;
  /** Numbers of open issues this one waits for. */
  readonly blockedBy: readonly number[];
  readonly pulls: readonly FlowPull[];
}

export interface FlowStage {
  readonly number: number;
  readonly title: string;
  readonly stage: Stage;
  /** When it entered this stage (ISO). */
  readonly since: string;
  readonly stalled: boolean;
  /** The one action that moves it on; "" once live. */
  readonly unblock: string;
  /** The pull the stage is about, when there is one. */
  readonly pull: number | null;
}

const later = (...times: (string | null)[]): string =>
  times.filter((t): t is string => t !== null).reduce((a, b) => (b > a ? b : a));

/** Where one open or merged pull stands. */
function pullStage(p: FlowPull): Omit<FlowStage, "number" | "title"> {
  const at = (stage: Stage, since: string, unblock: string) => ({
    stage,
    since,
    stalled: false,
    unblock,
    pull: p.number,
  });
  if (p.mergedAt !== null) {
    if (p.liveAt !== null) return at("live", p.liveAt, "");
    return at(
      "land",
      p.mergedAt,
      p.deployFailed ? "redeploy production" : "wait for the production deploy",
    );
  }
  const c = p.checks;
  if (c.state === "none")
    return at("pull", p.openedAt, `run the check on pull #${p.number}`);
  if (c.state === "running")
    return at("check", c.at ?? p.openedAt, `wait for the check on pull #${p.number}`);
  if (c.state === "failed")
    return at("check", c.at ?? p.openedAt, `re-run the check on pull #${p.number}`);
  const green = c.at ?? p.openedAt;
  if (p.changesRequested > 0)
    return at(
      "review",
      later(green, p.reviewedAt),
      `address the changes requested on pull #${p.number}`,
    );
  if (p.requireReview && p.approvals === 0)
    return at("review", green, `review pull #${p.number}`);
  return at("land", later(green, p.reviewedAt), `merge pull #${p.number}`);
}

export function flowStage(issue: FlowIssue, now: Date): FlowStage {
  const named = { number: issue.number, title: issue.title };
  const candidates = issue.pulls
    .filter((p) => p.state === "open" || p.mergedAt !== null)
    .map(pullStage);
  let chosen: Omit<FlowStage, "number" | "title">;
  if (candidates.length > 0) {
    // Furthest along wins; between equals, the one that has waited least.
    chosen = candidates.reduce((best, c) => {
      const a = STAGES.indexOf(c.stage);
      const b = STAGES.indexOf(best.stage);
      return a > b || (a === b && c.since > best.since) ? c : best;
    });
  } else {
    const since = later(issue.createdAt, ...issue.pulls.map((p) => p.closedAt));
    const open = issue.blockedBy;
    chosen = {
      stage: "issue",
      since,
      stalled: false,
      pull: null,
      unblock:
        open.length > 0
          ? `finish #${open[0]} first`
          : issue.assignee === null
            ? "assign a builder"
            : `ask ${issue.assignee} to open a pull`,
    };
  }
  const ageMinutes = (now.getTime() - Date.parse(chosen.since)) / 60_000;
  return { ...named, ...chosen, stalled: ageMinutes > STALL_MINUTES[chosen.stage] };
}
