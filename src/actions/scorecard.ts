/**
 * The crew's scorecard as data, for the doors that are not a page (the API
 * and MCP): each agent's figures over all time and the last `RECENT_DAYS`,
 * and the same cut by model and prompt version. A forge admin's to read.
 */
import type { App } from "../app.ts";
import {
  crewScorecardSplits,
  crewScorecards,
  recentWindow,
  type Scorecard,
  type SplitScorecard,
} from "../core/scorecard.ts";
import { modelDays, type ModelDay } from "../core/model_days.ts";
import { readReview } from "./model_review.ts";
import { wastedDays, type WastedDay } from "../core/wasted_days.ts";
import { listAgents } from "../core/agents.ts";
import { keeperDays, type KeeperDay } from "../flow/keeper_rate.ts";
import type { User } from "../core/users.ts";
import { weekCard } from "../crew/week_card.ts";

export interface AgentScorecard {
  readonly username: string;
  /** All time; null for an agent that has opened no pull. */
  readonly all: Scorecard | null;
  /** The last `RECENT_DAYS`; null when it opened none in that time. */
  readonly recent: Scorecard | null;
  /** The last 7 days, the same line /crew shows: merged, returned, cost in USD. */
  readonly week: { readonly merged: number; readonly returned: number; readonly cost: number };
  readonly splits: readonly (Scorecard & {
    readonly model: string;
    readonly prompt: string;
    readonly recent: Scorecard | null;
  })[];
}

const figures = (c: Scorecard): Scorecard => ({
  opened: c.opened,
  landed: c.landed,
  reviewRounds: c.reviewRounds,
  redCheckRate: c.redCheckRate,
  reverts: c.reverts,
  meanLandMs: c.meanLandMs,
});

/** Every agent's scorecard; `undefined` for anyone but a forge admin. */
export function readScorecards(
  app: App,
  actor: User | undefined,
): {
  agents: AgentScorecard[];
  modelDays: ModelDay[];
  wastedDays: WastedDay[];
  keeperDays: KeeperDay[];
  modelReview: ReturnType<typeof readReview>;
} | undefined {
  if (actor?.isAdmin !== true) return undefined;
  const window = recentWindow();
  const all = crewScorecards(app.db);
  const recent = crewScorecards(app.db, window);
  const splits = crewScorecardSplits(app.db);
  const recentSplits = crewScorecardSplits(app.db, window);
  const week = new Map(weekCard(app.db).map((l) => [l.username, l]));
  const key = (p: SplitScorecard) => `${p.model}\u0000${p.promptVersion}`;
  return {
    modelDays: modelDays(app.db),
    // Hours the forge ran and pulls landed, per UTC day of the last week (#7645).
    keeperDays: keeperDays(app.db, new Date()),
    modelReview: readReview(app),
    wastedDays: wastedDays(app.db),
    agents: listAgents(app.db).map((agent) => {
      const id = agent.user.id;
      const lately = new Map((recentSplits.get(id) ?? []).map((p) => [key(p), p]));
      const a = all.get(id);
      const r = recent.get(id);
      const w = week.get(agent.user.username);
      return {
        username: agent.user.username,
        all: a === undefined ? null : figures(a),
        recent: r === undefined ? null : figures(r),
        week: {
          merged: w?.merged ?? 0,
          returned: w?.returned ?? 0,
          cost: w?.spentUsd ?? 0,
        },
        splits: (splits.get(id) ?? []).map((p) => {
          const l = lately.get(key(p));
          return {
            model: p.model,
            prompt: p.promptVersion,
            ...figures(p),
            recent: l === undefined ? null : figures(l),
          };
        }),
      };
    }),
  };
}
