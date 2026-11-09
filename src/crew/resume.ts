/**
 * Whether a follow-up resumes the agent's last session or starts fresh.
 * Resuming replays the whole transcript to the provider; once its cache has
 * let the session go, the replay is billed in full before the first new
 * turn, and costs about what the run that wrote it cost. Over one afternoon
 * (2026-11-09, 192 runs) a resumed follow-up cost 3× a fresh one per turn
 * and $0.85 against $0.32 per run, for four turns saved; the planner's
 * standing session cost $3 to open nothing.
 *
 * So a session is resumed only while it is cheap to: within `WARM_MS` of its
 * end, while the provider's cache still holds it, or when it was short.
 * Otherwise the follow-up starts fresh: the brief carries the review, the
 * failing check or the conflict, and the clone carries the branch. Pure.
 */

/** How long after a session ends the provider's cache is trusted to hold it. */
export const WARM_MS = 4 * 60_000;
/** A session of this many turns or fewer, and under `SHORT_USD`, is cheap to replay at any age. */
export const SHORT_TURNS = 6;
/** A short session that cost more than this replayed a long one itself: its transcript is long. */
export const SHORT_USD = 0.15;
/** A session that ended holding this much context or less is cheap to replay at any age. */
export const SHORT_CONTEXT_TOKENS = 40_000;

export interface LastSession {
  readonly sessionId: string;
  readonly turns: number;
  readonly costUsd: number;
  /** The context the session held at its end, in tokens; 0 when the run did not record it. */
  readonly contextTokens: number;
  readonly finishedAt: string | null;
}

export interface Resume {
  readonly resume: boolean;
  /** The log's line when a session exists and is not resumed; "" otherwise. */
  readonly why: string;
}

const NONE: Resume = { resume: false, why: "" };

/** Whether `last` is still warm in the provider's cache at `now`. */
export function warm(
  last: Pick<LastSession, "finishedAt">,
  now: number,
): boolean {
  if (last.finishedAt === null) return false;
  const ended = Date.parse(last.finishedAt);
  return Number.isFinite(ended) && now - ended < WARM_MS;
}

/**
 * Whether `last` is short enough to replay cheaply whatever its age: by the
 * context it held when the run recorded it, else by turns and cost.
 */
export function short(
  last: Pick<LastSession, "turns" | "costUsd" | "contextTokens">,
): boolean {
  if (last.contextTokens > 0) return last.contextTokens <= SHORT_CONTEXT_TOKENS;
  return last.turns <= SHORT_TURNS && last.costUsd <= SHORT_USD;
}

/** `62k tokens of context, ` when the run recorded it; "" otherwise. */
const contextWords = (last: Pick<LastSession, "contextTokens">): string =>
  last.contextTokens > 0
    ? `${Math.round(last.contextTokens / 1000)}k tokens of context, `
    : "";

const ago = (last: LastSession, now: number): string => {
  if (last.finishedAt === null) return "ended at an unknown time";
  const minutes = Math.max(
    0,
    Math.round((now - Date.parse(last.finishedAt)) / 60_000),
  );
  return minutes < 60
    ? `ended ${minutes} min ago`
    : `ended ${Math.round(minutes / 6) / 10} h ago`;
};

/** The decision for a follow-up at `now`, given the agent's last finished run on the task. */
export function resumeDecision(
  last: LastSession | undefined,
  now: number,
): Resume {
  if (last === undefined || last.sessionId === "") return NONE;
  if (short(last) || warm(last, now)) return { resume: true, why: "" };
  return {
    resume: false,
    why: `session ${last.sessionId} not resumed: ${contextWords(last)}${last.turns} turns, $${last.costUsd.toFixed(2)}, ${ago(last, now)}; replaying it would cost about what it cost to write, so this run starts fresh`,
  };
}
