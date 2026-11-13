/**
 * What the picker passes over, and why (#8924). A startable ready issue is
 * passed over for one of four reasons: polish has taken its share of the
 * week, the owner's bets do not cover it, no builder may take it now, or
 * (held, not passed) `held.ts` holds it. Small and free of the tick, so
 * Next up on the web, in the terminal and over MCP names the reason without
 * loading the autonomy loop.
 */

import type { App } from "../app.ts";
import { backedBetOf, betsInUse } from "../core/bets.ts";
import type { Ranked } from "../core/dependencies.ts";
import { firstAt } from "../core/first.ts";
import { labelsForIssues } from "../core/issues.ts";
import { ranksInRepo } from "../core/rank.ts";
import type { Repo } from "../core/repos.ts";
import { raisedAt } from "../core/thought_links.ts";
import type { Agent, CrewRole } from "../core/agents.ts";
import { mayPick } from "./bets.ts";
import { isPolish, polishSpend, smallIssues } from "./polish_share.ts";
import { shunnedBy } from "./stalls.ts";

/** Why the picker passes a startable issue over. */
export type PassedOver = "polish_share" | "no_bet" | "no_builder";

/** The words for each, as Next up and the tick line say them. */
export const PASSED_WORDS: Readonly<Record<PassedOver, string>> = {
  polish_share: "polish has taken its share of the week",
  no_bet: "it is in no backed bet, and was not raised, put first or small",
  no_builder: "no builder may take it now: each is shunned from it or there is none",
};

/**
 * The builders that may take this issue: a builder that stalled it within
 * the hour leaves it to the others (#4073).
 */
export function crewFor<C extends { readonly agent: Agent; readonly role: CrewRole }>(
  app: App,
  repo: Repo,
  issueId: string,
  crew: readonly C[],
  now: Date,
): C[] {
  const shunned = shunnedBy(app.db, repo, issueId, now);
  return crew.filter((c) => c.role !== "builder" || !shunned.has(c.agent.user.id));
}

/** The ready issues no builder may take now; the others stay in order. */
export function routable<C extends { readonly agent: Agent; readonly role: CrewRole }>(
  app: App,
  repo: Repo,
  ready: readonly Ranked[],
  crew: readonly C[],
  now: Date,
): { kept: Ranked[]; passed: Map<string, PassedOver> } {
  const passed = new Map<string, PassedOver>();
  const kept = ready.filter((r) => {
    if (crewFor(app, repo, r.issue.id, crew, now).some((c) => c.role === "builder")) return true;
    passed.set(r.issue.id, "no_builder");
    return false;
  });
  return { kept, passed };
}

/**
 * What the picker takes from `ready` and what it passes over, each with its
 * one reason (#8924): polish (labelled `polish`, or in the small-fixes lane)
 * stops once it has taken its share of the week (#8853); once the owner has
 * backed a bet, builders pick from backed bets, the owner's raised issues
 * and the small lane (#8713). What the owner raised, ranked or put first is
 * never held back by polish.
 */
export function pickFilter(
  app: App,
  repo: Repo,
  ready: readonly Ranked[],
  now: Date = new Date(),
): { allowed: Ranked[]; passed: Map<string, PassedOver> } {
  const issues = ready.map((r) => r.issue);
  const small = smallIssues(app.db, issues);
  const first = firstAt(app.db, issues.map((i) => i.id));
  // Read only when polish is over its share: the one place a rank is asked (#11619 trims a statement from /next).
  let rankedIds: ReadonlyMap<string, number> | undefined;
  const ranked = { has: (id: string): boolean => (rankedIds ??= ranksInRepo(app.db, repo.id).places).has(id) };
  const raised = raisedAt(app.db, issues.map((i) => i.id));
  const bets = betsInUse(app.db, repo.id) ? backedBetOf(app.db, repo.id, issues.map((i) => i.id)) : undefined;
  const polishLabels = labelsForIssues(app.db, issues.map((i) => i.id));
  const polishOpen = polishSpend(app.db, repo.id, repo.polishShare, now).under;
  const passed = new Map<string, PassedOver>();
  const allowed = ready.filter((r) => {
    const id = r.issue.id;
    if (
      !polishOpen &&
      !raised.has(id) && !first.has(id) && !ranked.has(id) &&
      isPolish(r.issue.title, (polishLabels.get(id) ?? []).map((l) => l.name))
    ) {
      passed.set(id, "polish_share");
      return false;
    }
    if (bets !== undefined && !mayPick({ raised: raised.has(id) || first.has(id), small: small.has(id), bet: bets.get(id) })) {
      passed.set(id, "no_bet");
      return false;
    }
    return true;
  });
  return { allowed, passed };
}

/** The tick line's words for what the picker passed over: `no_bet=3 polish_share=1`, or `none`. */
export function passedWords(passed: ReadonlyMap<string, PassedOver>): string {
  const said = (Object.keys(PASSED_WORDS) as PassedOver[])
    .map((name) => [name, [...passed.values()].filter((p) => p === name).length] as const)
    .filter(([, n]) => n > 0)
    .map(([name, n]) => `${name}=${n}`);
  return said.length === 0 ? "none" : said.join(" ");
}
