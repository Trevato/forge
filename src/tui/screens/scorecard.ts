/**
 * The crew's scorecard in the terminal, a forge admin's (#2677): each
 * agent's pulls landed of opened, review rounds and red checks over the
 * last `RECENT_DAYS` days beside all time, then reverts and time to land
 * over all time, as Settings → Crew shows them (`crewScorecards`), with a sub-row per
 * model · prompt version (`crewScorecardSplits`). The gate
 * is the page's: a forge admin; anyone else sees nothing.
 */

import { listAllAgents } from "../../actions/crew.ts";
import { readSpend, type SpanName, type Spend } from "../../actions/spend.ts";
import {
  crewScorecards,
  crewScorecardSplits,
  teamScorecards,
  RECENT_DAYS,
  recentWindow,
  spanText,
  splitLabel,
  type Scorecard,
  type SplitScorecard,
} from "../../core/scorecard.ts";
import type { Agent } from "../../core/agents.ts";
import { listTeams, type Team } from "../../core/teams.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, drawList, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

const landed = (s: Scorecard | undefined) =>
  s === undefined ? "—" : `${s.landed} of ${s.opened}`;
const rounds = (s: Scorecard | undefined) =>
  s?.reviewRounds == null ? "—" : s.reviewRounds.toFixed(1);
const red = (s: Scorecard | undefined) =>
  s?.redCheckRate == null ? "—" : `${Math.round(100 * s.redCheckRate)}%`;

/** An agent's spend over 5h, today and 7d, as /settings/spend reads it; `—` for a span of none. */
export type AgentSpend = readonly [number, number, number];
const spendText = (v: AgentSpend | undefined): string =>
  v === undefined || v.every((n) => !(n > 0))
    ? "spend —"
    : `spend $ ${v.map((n) => (n > 0 ? n.toFixed(2) : "—")).join(" · ")}`;

/** Each agent's cost per span, by username, matched on the span's name and not its place. */
export function spendByAgent(spans: Spend["spans"]): Map<string, AgentSpend> {
  const cost = (span: SpanName, name: string): number =>
    spans.find((x) => x.span === span)?.byAgent.find((l) => l.name === name)?.costUsd ?? 0;
  const names = new Set(spans.flatMap((x) => x.byAgent.map((l) => l.name)));
  return new Map(
    [...names].map((n): [string, AgentSpend] => [
      n,
      [cost("5h", n), cost("today", n), cost("week", n)],
    ]),
  );
}

/** One `readSpend` for the whole screen. */
const agentSpend = (f: Session) => spendByAgent(readSpend(f.app).spans);

/** The figures of one scorecard, as a list row's second and third lines. */
function figures(
  title: string,
  r: Scorecard | undefined,
  s: Scorecard,
  spend?: string,
): ListRow {
  const d = `${RECENT_DAYS}d`;
  return {
    title,
    secondary: `landed ${d} ${landed(r)} · all ${landed(s)}`,
    meta: [
      `review rounds ${d} ${rounds(r)} · all ${rounds(s)}`,
      `red checks ${d} ${red(r)} · all ${red(s)}`,
      `reverts ${s.reverts}`,
      `time to land ${s.meanLandMs === null ? "—" : spanText(s.meanLandMs)}`,
      ...(spend === undefined ? [] : [spend]),
    ].join("  "),
  };
}

/**
 * One row per agent; one with no pull yet says so rather than a row of
 * zeros. Each windowed figure reads "<recent>d … · all …", the page's order.
 * Under an agent, one indented row per model · prompt version its pulls ran
 * on, with the same figures ("unrecorded" for pulls from before runs
 * recorded them). Then one row per team that has a card, its members'
 * counts pooled (an agent on two teams counts in both), under the agents.
 */
export function scorecardRows(
  agents: readonly Agent[],
  cards: ReadonlyMap<string, Scorecard>,
  recent: ReadonlyMap<string, Scorecard>,
  splits: ReadonlyMap<string, readonly SplitScorecard[]> = new Map(),
  recentSplits: ReadonlyMap<string, readonly SplitScorecard[]> = new Map(),
  teams: readonly Team[] = [],
  teamCards: ReadonlyMap<string, Scorecard> = new Map(),
  recentTeamCards: ReadonlyMap<string, Scorecard> = new Map(),
  spend: ReadonlyMap<string, AgentSpend> = new Map(),
): ListRow[] {
  const agentRows = agents.flatMap((agent) => {
    const s = cards.get(agent.user.id);
    if (s === undefined)
      return [
        {
          title: agent.user.username,
          secondary: "no pull yet",
          meta: spendText(spend.get(agent.user.username)),
        },
      ];
    const lately = new Map(
      (recentSplits.get(agent.user.id) ?? []).map((p) => [splitLabel(p), p]),
    );
    return [
      figures(
        agent.user.username,
        recent.get(agent.user.id),
        s,
        spendText(spend.get(agent.user.username)),
      ),
      ...(splits.get(agent.user.id) ?? []).map((p) =>
        figures(`  ↳ ${splitLabel(p)}`, lately.get(splitLabel(p)), p),
      ),
    ];
  });
  const teamRows = teams.flatMap((team) => {
    const s = teamCards.get(team.slug);
    return s === undefined
      ? []
      : [figures(`team ${team.name}`, recentTeamCards.get(team.slug), s)];
  });
  return [...agentRows, ...teamRows];
}

export function scorecardScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  const allowed = f.user?.isAdmin === true;
  // Read once when the screen opens, as the page reads it once per request.
  const listed = allowed ? listAllAgents(f.app, f.user) : undefined;
  const rows =
    listed?.ok === true
      ? scorecardRows(
          listed.value,
          crewScorecards(f.db),
          crewScorecards(f.db, recentWindow()),
          crewScorecardSplits(f.db),
          crewScorecardSplits(f.db, recentWindow()),
          listTeams(f.db),
          teamScorecards(f.db),
          teamScorecards(f.db, recentWindow()),
          agentSpend(f),
        )
      : [];
  return {
    title: "Crew scorecard per agent",
    keys: [binding(["j", "k"], "move cursor")],
    render(area, s) {
      const c = ctx.theme.c;
      const [head, list] = split(area, "v", [len(1), fill(1)]);
      const text = !allowed
        ? "The crew's scorecard is read by a forge admin."
        : rows.length === 0
          ? "No agents yet."
          : `Over the last ${RECENT_DAYS} days (${RECENT_DAYS}d) and all time, ` +
            "as Settings → Crew shows it, with a pooled row per team.";
      s.text(head!.x, head!.y, truncate(text, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, list!, c, state, rows);
    },
    key: (e) => state.key(e, rows.length),
  };
}

/** Settings → Crew's scorecard per agent, as the page has it: a forge admin (#2677). */
export const entry: PaletteEntry = {
  id: "scorecard",
  title: "Crew scorecard per agent",
  hint: "each agent's pulls landed, review rounds, red checks, reverts, time to land",
  after: ["crew-handover"],
  offered: (session) => session.user?.isAdmin === true,
  run: (session, ctx) => ctx.push(scorecardScreen(session, ctx)),
};
