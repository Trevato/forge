/**
 * A decision the crew makes and keeps: `decideOr` with the rule behind it,
 * and a row in the ledger for the one answer that matters. The question
 * named after the kind is the one recorded; any others ride along.
 */

import type { App } from "../app.ts";
import {
  recordDecision,
  type Decision,
  type DecisionKind,
} from "../core/decisions.ts";
import type { Issue } from "../core/issues.ts";
import type { Repo } from "../core/repos.ts";
import {
  decideOr,
  type Answers,
  type Decided,
  type Questions,
  type State,
} from "./decide.ts";

export interface Recorded<Q extends Questions> extends Decided<Q> {
  readonly decision: Decision;
}

export async function decideAndRecord<Q extends Questions>(
  app: App,
  about: { kind: DecisionKind; repo: Repo; issue?: Issue | undefined },
  state: State,
  questions: Q,
  rule: () => Answers<Q>,
): Promise<Recorded<Q>> {
  const decided = await decideOr(app.config.decider, state, questions, rule);
  const answer = decided.answers[about.kind as keyof Q];
  const decision = recordDecision(app.db, {
    kind: about.kind,
    repoId: about.repo.id,
    issueId: about.issue?.id,
    state,
    answer: answer?.choice ?? "",
    p: answer?.p ?? 1,
    by: decided.by,
    ms: decided.ms,
  });
  return { ...decided, decision };
}
