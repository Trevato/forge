/**
 * Which model a run uses (#7570). The agent's own model is the default;
 * work that costs more to get wrong escalates to Opus: a P0 issue or one
 * labelled `opus`, a planner's run, and the next round of a pull that has
 * been sent back for changes twice. The reason is recorded on the run row.
 */
import type { Database } from "bun:sqlite";
import type { Repo } from "../core/repos.ts";
import { labelsFor, type Issue } from "../core/issues.ts";
import { REVIEW_ROUNDS } from "../core/reviews.ts";
import { pillarsOf, servedBy } from "../core/pillars.ts";

/** The model escalated runs ask Claude Code for. */
export const OPUS_MODEL = "opus";
/** Changes-requested reviews after which a pull's next round runs on Opus. */
export const BOUNCED_ROUNDS = REVIEW_ROUNDS;
/** The label that asks for Opus by hand. */
export const OPUS_LABEL = "opus";

export interface ModelFacts {
  readonly agentModel: string;
  readonly role: string | undefined;
  readonly p0: boolean;
  readonly labelled: boolean;
  readonly bouncedRounds: number;
}

export interface ModelChoice {
  /** Empty: the runner's default. */
  readonly model: string;
  /** `agent`, or what escalated: `p0`, `label:opus`, `planner`, `bounced:N`. */
  readonly reason: string;
}

/** Pure: the facts of the work in, the model and why out. */
export function chooseModel(facts: ModelFacts): ModelChoice {
  if (facts.p0) return { model: OPUS_MODEL, reason: "p0" };
  if (facts.labelled) return { model: OPUS_MODEL, reason: `label:${OPUS_LABEL}` };
  if (facts.role === "planner") return { model: OPUS_MODEL, reason: "planner" };
  if (facts.bouncedRounds >= BOUNCED_ROUNDS)
    return { model: OPUS_MODEL, reason: `bounced:${facts.bouncedRounds}` };
  return { model: facts.agentModel, reason: "agent" };
}

/** Reads the facts about the issues a run is for (the pull, and the issue it closes). */
export function modelFacts(
  db: Database,
  repo: Repo,
  issues: readonly Issue[],
  agentModel: string,
  role: string | undefined,
  reviewing = false,
): ModelFacts {
  const ids = issues.map((i) => i.id);
  const serving = servedBy(db, pillarsOf(db, repo));
  const p0 = ids.some((id) => /^P0\b/.test(serving.get(id) ?? ""));
  const labelled = ids.some((id) =>
    labelsFor(db, id).some((l) => l.name.toLowerCase() === OPUS_LABEL),
  );
  // A reviewer reads a bounced pull; it is not the next round of the work.
  let bouncedRounds = 0;
  for (const issue of reviewing ? [] : issues) {
    if (issue.kind !== "pull") continue;
    bouncedRounds = db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM review WHERE issue_id = ?1 AND state = 'changes_requested'",
      )
      .get(issue.id)!.n;
  }
  return { agentModel, role, p0, labelled, bouncedRounds };
}
