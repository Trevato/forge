/**
 * "Let the decider" on a hand-over card, for every door: the web form, the
 * JSON API, MCP and the terminal all call these two functions. They own the
 * checks (the card must ask this person now, a decider must be set up, a
 * card is handed over at most once in `HAND_COOLDOWN_MS`) and hand back
 * plain data; `crew/handover.ts` owns the decider's side.
 */

import type { App } from "../app.ts";
import { getDecision } from "../core/decisions.ts";
import { getIssueById } from "../core/issues.ts";
import { getRepoById } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { guardedHand, letDeciderHandle, undoHandled } from "../crew/handover.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { askTargetsFor } from "../web/studio/asks.ts";
import type { FleetError } from "./fleet.ts";
import { SIGN_IN_TO_ACT } from "./asks_words.ts";

export { HAND_COOLDOWN_MS } from "../crew/handover.ts";

/** What the decider did with a card: plain data for any door. */
export interface HandAnswer {
  readonly id: string;
  readonly ask: string;
  readonly answer: "set_aside" | "ask_owner";
  readonly confidence: number;
  readonly by: string;
  readonly reason: string;
  /** Whether the card left the board; only then is there an undo. */
  readonly setAside: boolean;
  readonly context: unknown;
}

const fail = (code: FleetError["code"], message: string) =>
  err<FleetError>({ code, message });

const ASK_ID = /^(parked|issue):[A-Za-z0-9_-]{1,64}$/;

function describe(ask: string, d: NonNullable<ReturnType<typeof getDecision>>): HandAnswer {
  const state = (d.state ?? {}) as { reason?: unknown };
  return {
    id: d.id,
    ask,
    answer: d.answer === "set_aside" ? "set_aside" : "ask_owner",
    confidence: d.p,
    by: d.by,
    reason: typeof state.reason === "string" ? state.reason : d.answer,
    setAside: d.outcome === "set_aside",
    context: d.state,
  };
}

/** Hand one parked card (`parked:<issue id>`, or `issue:<id>` of a parked one) to the decider. */
export async function decideAsk(
  app: App,
  actor: User | undefined,
  item: unknown,
  now = Date.now(),
): Promise<Result<HandAnswer, FleetError>> {
  if (!actor) return fail("unauthorized", SIGN_IN_TO_ACT);
  if (typeof item !== "string" || !ASK_ID.test(item))
    return fail("bad_action", "only a hand-over can be handed to the decider");
  if (app.config.decider === undefined)
    return fail("bad_action", "no decider is set up on this forge");
  const ask = `parked:${item.slice(item.indexOf(":") + 1)}`;
  // The same access the card itself has: it must ask this person now.
  const { issueIds } = askTargetsFor(app.db, actor, [ask]);
  const issue = issueIds[0] === undefined ? undefined : getIssueById(app.db, issueIds[0]);
  const repo = issue === undefined ? undefined : getRepoById(app.db, issue.repoId);
  if (issue === undefined || repo === undefined)
    return fail("not_found", "it no longer asks you");
  const handed = await guardedHand(app, issue.id, now, () =>
    letDeciderHandle(app, actor, repo, issue, repo.decisionsBy),
  );
  if (handed === "busy")
    return fail(
      "too_many",
      "the decider answered this a moment ago; try again in a few minutes",
    );
  return ok(describe(ask, handed.decision));
}

/** Put a set-aside card back on the board, within a day. */
export function undoDecideAsk(
  app: App,
  actor: User | undefined,
  decisionId: unknown,
): Result<HandAnswer, FleetError> {
  if (!actor) return fail("unauthorized", SIGN_IN_TO_ACT);
  if (typeof decisionId !== "string" || decisionId === "")
    return fail("not_found", "no such decision");
  const undone = undoHandled(app, actor, decisionId);
  if (undone === "not_found") return fail("not_found", "no such decision");
  if (undone === "too_late")
    return fail("expired", "a day has passed; it stays set aside");
  return ok({
    ...describe(`parked:${undone.issueId ?? ""}`, undone),
    reason: "Back on your board.",
  });
}
