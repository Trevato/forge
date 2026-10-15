/**
 * "Let the decider" on a hand-over card: the owner hands an issue the crew
 * parked to the decider instead of answering it. The decider sees a curated
 * context — the direction, whether the owner pinned or muted the repository,
 * the day's spend against the ceiling, the owner's last ten decisions there
 * and the card's own evidence — and nothing else. Its answer is a row in the
 * decision ledger carrying that context, a reason and a confidence.
 *
 * Only a sure answer to set the card aside takes it off the board (the
 * owner's own dismissal, so undo for a day is the dismissal taken back).
 * Without a decider, or when it is unsure, the card stays: the rule is
 * "ask the owner", which is what the card already does.
 */

import type { App } from "../app.ts";
import { recentEnds } from "../core/ask_ledger.ts";
import {
  getDecision,
  recordDecision,
  setOutcome,
  type Decision,
} from "../core/decisions.ts";
import {
  askDismissals,
  mutedRepos,
  recordInteraction,
  removeDismissals,
} from "../core/interactions.ts";
import type { Issue } from "../core/issues.ts";
import { isPinned } from "../core/pins.ts";
import type { Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { spentTodayForRepos } from "./autonomy.ts";
import { certain, decideOr, type Answers, type Questions } from "./decide.ts";
import { parkReasons } from "./parks.ts";

/** How long undo keeps a set-aside card restorable. */
export const HAND_UNDO_MS = 86_400_000;

/** The least confidence at which an answer takes a card off the board. */
export const SURE = 0.7;

const SET_ASIDE = "set_aside";
const ASK_OWNER = "ask_owner";

const QUESTIONS = {
  hand: {
    about:
      "The crew parked an issue after repeated failed runs and handed it over. Is it fine to set it aside, or does the owner need to see it?",
    options: [SET_ASIDE, ASK_OWNER],
    describe: {
      [SET_ASIDE]:
        "Not worth the owner's time or the crew's spend now: the direction, the owner's past decisions or the budget say it can wait",
      [ASK_OWNER]: "The owner should decide this one",
    },
  },
} as const satisfies Questions;

/** Plain data: what the decider saw, and so what the ledger row shows. */
export interface HandContext {
  readonly direction: string;
  readonly repository: {
    readonly name: string;
    readonly pinned: boolean;
    readonly muted: boolean;
  };
  readonly spend: { readonly todayUsd: number; readonly ceilingUsd: number };
  readonly recent: readonly { kind: string; how: string; at: string }[];
  readonly evidence: {
    readonly number: number;
    readonly title: string;
    readonly reasons: readonly string[];
  };
}

const DIRECTION_MAX = 2_000;

export function handContext(
  app: App,
  owner: User,
  repo: Repo,
  issue: Issue,
): HandContext {
  const db = app.db;
  return {
    direction: repo.autonomyDirection.slice(0, DIRECTION_MAX),
    repository: {
      name: repo.name,
      pinned: isPinned(db, owner.id, repo.id),
      muted: mutedRepos(db, owner.id).has(repo.id),
    },
    spend: {
      todayUsd: spentTodayForRepos(db, [repo.id]).get(repo.id) ?? 0,
      ceilingUsd: repo.autonomyCeilingUsd,
    },
    recent: recentEnds(db, owner.id, repo.id, 10),
    evidence: {
      number: issue.number,
      title: issue.title,
      reasons: parkReasons(db, repo, issue.id),
    },
  };
}

/** The dismissal item a parked card is set aside under (`askItemsOf`). */
const itemOf = (issue: Issue): string => `ask:parked:${issue.id}`;

export interface Handled {
  readonly decision: Decision;
  /** Whether the card left the board. */
  readonly setAside: boolean;
}

/**
 * Ask the decider about one hand-over. The caller owes the access check:
 * `issue` is a parked card that asks `owner` now.
 */
export async function letDeciderHandle(
  app: App,
  owner: User,
  repo: Repo,
  issue: Issue,
): Promise<Handled> {
  const context = handContext(app, owner, repo, issue);
  const rule = (): Answers<typeof QUESTIONS> => ({
    hand: certain([SET_ASIDE, ASK_OWNER], ASK_OWNER),
  });
  const decided = await decideOr(
    app.config.decider,
    context as unknown as Record<string, unknown>,
    QUESTIONS,
    rule,
  );
  const answer = decided.answers.hand;
  const sure = answer.choice === SET_ASIDE && answer.p >= SURE;
  const percent = Math.round(answer.p * 100);
  const reason = sure
    ? `Set aside, ${percent}% sure: nothing in the direction, the budget or your past decisions here asks for it now.`
    : decided.by === "rule"
      ? "No decider answered, so it stays with you."
      : `Unsure (${percent}% for ${answer.choice === SET_ASIDE ? "setting it aside" : "asking you"}), so it stays with you.`;
  const decision = recordDecision(app.db, {
    kind: "hand",
    repoId: repo.id,
    issueId: issue.id,
    state: { ...context, reason },
    answer: sure ? SET_ASIDE : ASK_OWNER,
    p: answer.p,
    by: decided.by,
    ms: decided.ms,
  });
  if (sure) {
    recordInteraction(app.db, {
      viewerId: owner.id,
      itemId: itemOf(issue),
      kind: "dismissed",
      repoId: repo.id,
      actorId: owner.id,
    });
    setOutcome(app.db, decision.id, "set_aside");
  } else setOutcome(app.db, decision.id, "asked");
  return { decision: getDecision(app.db, decision.id)!, setAside: sure };
}

/**
 * Take a set-aside back, within a day: the card returns to the board. Only
 * the owner's own, and only once. Returns the decision, or why not.
 */
export function undoHandled(
  app: App,
  owner: User,
  decisionId: string,
  now = Date.now(),
): Decision | "not_found" | "too_late" {
  const decision = getDecision(app.db, decisionId);
  if (
    decision === undefined ||
    decision.kind !== "hand" ||
    decision.outcome !== "set_aside" ||
    decision.issueId === null
  )
    return "not_found";
  // Someone else's set-aside is not found: only the dismissal's owner undoes it.
  const item = `ask:parked:${decision.issueId}`;
  if (!askDismissals(app.db, owner.id).has(item)) return "not_found";
  if (now - Date.parse(decision.createdAt) > HAND_UNDO_MS) return "too_late";
  removeDismissals(app.db, owner.id, [item]);
  setOutcome(app.db, decision.id, "undone");
  return getDecision(app.db, decision.id)!;
}
