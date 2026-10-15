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
  latestDecision,
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
import { canAdmin, getRepoById, type DecisionsBy, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { spentTodayForRepos } from "./autonomy.ts";
import { certain, decideOr, type Answers, type Questions } from "./decide.ts";
import { parkReasons } from "./parks.ts";

/** How long undo keeps a set-aside card restorable. */
export const HAND_UNDO_MS = 86_400_000;

/** The least confidence at which an answer takes a card off the board. */
export const SURE = 0.7;

/** A card is handed to the decider at most once in this long. */
export const HAND_COOLDOWN_MS = 10 * 60_000;

/** Cards whose model call is in flight: a tap and a tick must not both pay. */
const handing = new Set<string>();

/**
 * Run `go` for one card unless it was answered in the last ten minutes or a
 * call for it is in flight; then nothing runs and this says `"busy"`.
 */
export async function guardedHand<T>(
  app: App,
  issueId: string,
  now: number,
  go: () => Promise<T>,
): Promise<T | "busy"> {
  const last = latestDecision(app.db, issueId, "hand");
  if (
    handing.has(issueId) ||
    (last !== undefined && now - Date.parse(last.createdAt) < HAND_COOLDOWN_MS)
  )
    return "busy";
  handing.add(issueId);
  try {
    return await go();
  } finally {
    handing.delete(issueId);
  }
}

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

/**
 * The actor on a decision the standing rule took: no person's, so no one
 * viewer's dismissal. The ledger's `set_aside` outcome closes the card for
 * everyone it asks (`notDismissed` in `web/studio/asks.ts`).
 */
export const STANDING = "standing";

function dismissFor(app: App, owner: User, repo: Repo, issue: Issue): void {
  recordInteraction(app.db, {
    viewerId: owner.id,
    itemId: itemOf(issue),
    kind: "dismissed",
    repoId: repo.id,
    actorId: owner.id,
  });
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
  mode: DecisionsBy,
  standing = false,
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
  // Ruled "decider", its word stands; otherwise only a sure one does.
  const sure =
    answer.choice === SET_ASIDE && (mode === "decider" || answer.p >= SURE);
  const percent = Math.round(answer.p * 100);
  const reason = sure
    ? mode === "decider" && answer.p < SURE
      ? `Set aside, ${percent}% sure: this repository is ruled "decider", so its word stands.`
      : `Set aside, ${percent}% sure: nothing in the direction, the budget or your past decisions here asks for it now.`
    : decided.by === "rule"
      ? "No decider answered, so it stays with you."
      : `Unsure (${percent}% for ${answer.choice === SET_ASIDE ? "setting it aside" : "asking you"}), so it stays with you.`;
  const decision = recordDecision(app.db, {
    kind: "hand",
    repoId: repo.id,
    issueId: issue.id,
    state: { ...context, reason, actor: standing ? STANDING : owner.id },
    answer: sure ? SET_ASIDE : ASK_OWNER,
    p: answer.p,
    by: decided.by,
    ms: decided.ms,
  });
  if (sure) {
    if (!standing) dismissFor(app, owner, repo, issue);
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
  const said = decision.state as { actor?: unknown } | null;
  const byRule = said?.actor === STANDING;
  if (!byRule && said?.actor !== owner.id) return "not_found";
  if (byRule) {
    // The rule's set-aside is the repository's: any admin of it may take it back.
    const repo = getRepoById(app.db, decision.repoId);
    if (repo === undefined || !canAdmin(app.db, repo, owner)) return "not_found";
  } else if (!askDismissals(app.db, owner.id).has(item)) return "not_found";
  if (now - Date.parse(decision.createdAt) > HAND_UNDO_MS) return "too_late";
  if (!byRule) removeDismissals(app.db, owner.id, [item]);
  setOutcome(app.db, decision.id, "undone");
  return getDecision(app.db, decision.id)!;
}

/**
 * A ledger row as `reader` may see it. A hand-over's state holds the tapper's
 * own pins, mutes, recent endings and id: only they get those back; anyone
 * else who can read the repository gets the rest.
 */
export function forReader(d: Decision, reader: User | undefined): Decision {
  if (d.kind !== "hand") return d;
  const state = (d.state ?? {}) as Record<string, any>;
  if (reader !== undefined && state.actor === reader.id) return d;
  const { actor: _a, recent: _r, repository, ...rest } = state;
  return {
    ...d,
    state: { ...rest, repository: { name: repository?.name } },
  };
}

/**
 * A hand-over on a shelved repository — its crew is off, so nothing will
 * pick the issue up again — closes without a model call: the rule answers,
 * in the ledger, with the same context and the same undo. Only the standing
 * sweep calls it, so it is recorded as the standing rule's and dismisses for
 * no one.
 */
export function setAsideShelved(
  app: App,
  owner: User,
  repo: Repo,
  issue: Issue,
): Handled {
  const context = handContext(app, owner, repo, issue);
  const decision = recordDecision(app.db, {
    kind: "hand",
    repoId: repo.id,
    issueId: issue.id,
    state: {
      ...context,
      reason: "Set aside: the crew is off here, so nothing will pick it up.",
      actor: STANDING,
    },
    answer: SET_ASIDE,
    p: 1,
    by: "rule",
    ms: 0,
  });
  setOutcome(app.db, decision.id, "set_aside");
  return { decision: getDecision(app.db, decision.id)!, setAside: true };
}
