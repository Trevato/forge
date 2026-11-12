/**
 * What the decider did today, in the terminal: the board's Today line and the
 * rows behind each count, from the same `deciderCounts` and `listDeciderPile`
 * reads. Only repositories this person holds owner facts for are counted —
 * the board's own gate — so a guest or a reader sees nothing.
 */

import type { Database } from "bun:sqlite";
import { returnsRepos } from "../../actions/returns.ts";
import { startOfTodayUtc } from "../../crew/autonomy.ts";
import {
  DECIDER_PILES,
  PILE_EMPTY,
  deciderCounts,
  listDeciderPile,
  type DeciderPile,
} from "../../core/decisions.ts";
import { efficiencyForRepos, perShippedWords } from "../../core/efficiency.ts";
import { deciderSentence } from "../../story/words.ts";
import { getIssuesByIds } from "../../core/issues.ts";
import { getReposByIds } from "../../core/repos.ts";
import type { User } from "../../core/users.ts";
import type { App } from "../../app.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { emptyState } from "../ui/widgets.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { ListState, drawList, hitList, metaOf, openOnWeb, relTime, type ListRow } from "./common.ts";

const ROWS = 200;

export interface DeciderRow extends ListRow {
  /** The web path `enter` opens. */
  readonly path: string;
}

/** The repositories whose decisions this viewer may count: the board's ownerFacts. */
const owned = (app: App, viewer: User | undefined): string[] =>
  viewer === undefined ? [] : returnsRepos(app, viewer).map((r) => r.id);

/** `deciderSentence` with today's counts; null on a quiet day. */
export function deciderLine(app: App, viewer: User | undefined, now = new Date()): string | null {
  const n = deciderCounts(app.db, owned(app, viewer), startOfTodayUtc(now).toISOString());
  return n.closed + n.deferred + n.asked === 0 ? null : deciderSentence((pile) => n[pile]).join("");
}

const COST_LINES = 3;

/** One muted line per owned app that ran or shipped this week, at most three, then `+N more apps`. */
export function efficiencyLines(app: App, viewer: User | undefined, now = new Date()): string[] {
  const repos = viewer === undefined ? [] : returnsRepos(app, viewer);
  const week = efficiencyForRepos(
    app.db,
    repos.map((r) => r.id),
    new Date(now.getTime() - 7 * 86_400_000).toISOString(),
  );
  const lines = repos.flatMap((r) => {
    const e = week.get(r.id);
    return e === undefined ? [] : [`${r.name}: ${perShippedWords(e)} this week`];
  });
  const more = lines.length - COST_LINES;
  return more <= 0 ? lines : [...lines.slice(0, COST_LINES), `+${more} more app${more === 1 ? "" : "s"}`];
}

/** The ledger rows behind one pile's count today, newest first. */
export function deciderRows(app: App, viewer: User | undefined, pile: DeciderPile, now = new Date()): DeciderRow[] {
  const db: Database = app.db;
  const ids = owned(app, viewer);
  const decisions = listDeciderPile(db, ids, pile, startOfTodayUtc(now).toISOString(), ROWS);
  const about = getIssuesByIds(db, decisions.flatMap((d) => (d.issueId === null ? [] : [d.issueId])));
  const repos = getReposByIds(db, [...new Set(decisions.map((d) => d.repoId))]);
  return decisions.flatMap((d) => {
    const repo = repos.get(d.repoId);
    if (repo === undefined) return [];
    const issue = d.issueId === null ? undefined : about.get(d.issueId);
    const base = `/${repo.ownerName}/${repo.name}`;
    return [
      {
        title: (issue?.title ?? repo.name).replace(/[\u0000-\u001f\u007f-\u009f]+/g, " "),
        secondary: `${repo.ownerName}/${repo.name}${issue ? ` #${issue.number}` : ""} · ${d.by === "rule" ? "by the rule" : `by ${d.by}`}`,
        meta: metaOf(d.outcome ?? "", relTime(d.createdAt)),
        path: issue === undefined ? base : `${base}/${issue.kind === "pull" ? "pulls" : "issues"}/${issue.number}`,
      },
    ];
  });
}

export function deciderScreen(f: Session, ctx: Ctx, first: DeciderPile = "closed"): Screen {
  const state = new ListState();
  let pile: DeciderPile = first;
  let rows: DeciderRow[] = [];
  let line: string | null = null;
  let costs: string[] = [];
  const read = (): void => {
    line = deciderLine(f.app, f.user);
    costs = efficiencyLines(f.app, f.user);
    rows = deciderRows(f.app, f.user, pile);
    state.clamp(rows.length);
  };
  const pick = (next: DeciderPile): void => {
    pile = next;
    state.index = 0;
    read();
    ctx.invalidate();
  };
  const open = (index: number): void => {
    const row = rows[index];
    if (row !== undefined) openOnWeb(f, ctx, row.path, "That card");
  };
  return {
    title: "Decider",
    keys: [
      binding(["1", "2", "3"], "closed · deferred · asked"),
      binding(["j", "k"], "move"),
      binding(["enter"], "open"),
      binding(["r"], "refresh"),
    ],
    load: async () => read(),
    render(area, s) {
      const c = ctx.theme.c;
      const [head, body] = split(area, "v", [len(1 + costs.length), fill(1)]);
      const sentence = `${line ?? "The decider has done nothing today."}  [${pile}]`;
      s.text(head!.x, head!.y, truncate(sentence, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      costs.forEach((t, i) => s.text(head!.x, head!.y + 1 + i, truncate(t, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w));
      if (rows.length === 0) {
        emptyState(s, body!, c, { title: PILE_EMPTY[pile], body: "Press 1, 2 or 3 for another pile." });
        return;
      }
      drawList(s, body!, c, state, rows);
      hitList(ctx, body!, state, rows.length, { open });
    },
    key(e) {
      const i = Number(e.key) - 1;
      if (Number.isInteger(i) && i >= 0 && i < DECIDER_PILES.length) return pick(DECIDER_PILES[i]!), true;
      if (state.key(e, rows.length)) return true;
      if (e.key === "enter") return open(state.index), true;
      if (e.key === "r") return read(), ctx.invalidate(), true;
      return false;
    },
  };
}
