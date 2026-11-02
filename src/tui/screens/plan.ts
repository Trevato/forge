/**
 * The repository's plan in one screen: who is working, what is ready now,
 * what waits on what, and what the crew parked twice. The reads are MCP
 * `map`'s own (`repoGraph` under the reader's `sealedScope`, `pillarView`,
 * `mapHeldFor`, `listActiveRuns`), so a sealed issue the reader may not see
 * is left out here as it is there.
 */

import { FIRST_FORBIDDEN, putIssueFirst } from "../../actions/first.ts";
import { firstMarksInRepo } from "../../core/first.ts";
import { repoGraph, readyNow } from "../../core/dependencies.ts";
import { pillarView } from "../../core/pillars.ts";
import { listActiveRuns } from "../../core/runs.ts";
import type { Repo } from "../../core/repos.ts";
import { sealedScope } from "../../core/sealed.ts";
import { mapHeldFor } from "../../crew/held.ts";
import { marksFor } from "../../web/pages/map.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { ListState, drawList, hitList, live, runAsync, type ListRow } from "./common.ts";
import { issueScreen } from "./issue.ts";
import { local } from "./where.ts";

/** A line of the plan: a group's heading (no `number`) or one issue. */
export interface PlanLine {
  readonly text: string;
  readonly number?: number;
  /** A ready issue: the one `f` puts first. */
  readonly ready?: true;
}

export function readPlan(f: Session, repo: Repo): PlanLine[] {
  const scope = sealedScope(f.db, repo, f.user);
  const graph = repoGraph(f.db, repo.id, { ...scope });
  const pillars = pillarView(f.db, repo);
  const marks = marksFor(f.db, repo.id, graph, listActiveRuns(f.db, [repo.id]));
  const held = mapHeldFor(f.app, repo, graph, scope);
  const byId = new Map(graph.issues.map((i) => [i.id, i]));
  const open = (id: string): boolean => byId.get(id)?.state === "open";

  const working = graph.issues.filter((i) => i.state === "open" && marks.crew.has(i.id));
  const twice = new Set(marks.twice.map((t) => t.number));
  // Parked twice is the planner's: it is listed once, under its own heading.
  const ready = readyNow(graph).filter(
    (r) => !marks.crew.has(r.issue.id) && !twice.has(r.issue.number),
  );
  const readyIds = new Set(ready.map((r) => r.issue.id));
  const waits = new Map<string, number[]>();
  for (const e of graph.edges) {
    const blocker = byId.get(e.blockedById);
    if (blocker === undefined || !open(e.blockedById)) continue;
    waits.set(e.issueId, [...(waits.get(e.issueId) ?? []), blocker.number]);
  }
  const waiting = graph.issues.filter(
    (i) => open(i.id) && !marks.crew.has(i.id) && !readyIds.has(i.id) && waits.has(i.id),
  );
  const hold = (n: number): string => {
    const h = held.holds.get(n);
    return h === undefined ? "" : ` (${h.detail})`;
  };

  const firsts = firstMarksInRepo(f.db, repo.id);
  const lines: PlanLine[] = [{ text: `Working ${working.length}` }];
  for (const i of working)
    lines.push({
      text: `#${i.number} ${i.title} — ${i.assigneeName ?? "crew"}`,
      number: i.number,
    });
  lines.push({ text: `Ready now ${ready.length}` });
  for (const { issue: i } of ready)
    lines.push({
      text: `#${i.number} ${i.title} — ${pillars?.of.get(i.id) ?? "no pillar"}${hold(i.number)}${
        firsts.has(i.id) ? ` — first, by ${firsts.get(i.id)!.by}` : ""
      }`,
      number: i.number,
      ready: true,
    });
  lines.push({ text: `Waiting ${waiting.length}` });
  for (const i of waiting)
    lines.push({
      text: `#${i.number} ${i.title} — waits on ${waits
        .get(i.id)!
        .slice()
        .sort((a, b) => a - b)
        .map((n) => `#${n}`)
        .join(", ")}${hold(i.number)}`,
      number: i.number,
    });
  lines.push({ text: `Parked twice ${marks.twice.length}` });
  for (const t of marks.twice)
    lines.push({ text: `#${t.number} ${t.title} — ${t.reasons.join("; ")}`, number: t.number });
  return lines;
}

export function planScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  const state = new ListState();
  let lines: PlanLine[] = [];
  /** Headings are not rows to stand on: the cursor moves on to the next issue, `dir` first. */
  const settle = (dir: 1 | -1): void => {
    const at = (i: number): boolean => lines[i]?.number !== undefined;
    for (const d of [dir, -dir]) {
      for (let i = state.index; i >= 0 && i < lines.length; i += d)
        if (at(i)) {
          state.index = i;
          return;
        }
    }
  };
  const reload = (): void => {
    lines = readPlan(f, repo);
    state.clamp(lines.length);
    settle(1);
    ctx.invalidate();
  };
  const openAt = (index: number): void => {
    const number = lines[index]?.number;
    if (number !== undefined) ctx.push(issueScreen(f, ctx, local(f, repo), number));
  };
  return {
    title: "Plan",
    keys: [binding(["j", "k"], "move"), binding(["enter"], "open"), binding(["f"], "first"), binding(["r"], "refresh")],
    load(signal) {
      live(f, signal, { repoId: repo.id }, () => runAsync(ctx, async () => reload()));
      reload();
      return Promise.resolve();
    },
    render(area, s) {
      const c = ctx.theme.c;
      const rows: ListRow[] = lines.map((l) => ({ title: l.text }));
      drawList(s, area, c, state, rows);
      hitList(ctx, area, state, rows.length, { open: openAt });
    },
    key(e) {
      const before = state.index;
      if (state.key(e, lines.length)) {
        settle(state.index >= before ? 1 : -1);
        return true;
      }
      if (e.key === "enter") {
        openAt(state.index);
        return true;
      }
      if (e.key === "f") {
        const line = lines[state.index];
        if (line?.ready === undefined || line.number === undefined) {
          ctx.toast("f puts a ready issue first", "danger");
        } else if (f.user === undefined) {
          ctx.toast(FIRST_FORBIDDEN, "danger");
        } else {
          const put = putIssueFirst(f.app, f.user, repo, line.number);
          if (!put.ok) ctx.toast(put.error.message, "danger");
          else {
            ctx.toast(`#${line.number} is first`, "success");
            reload();
          }
        }
        return true;
      }
      if (e.key === "r") {
        reload();
        return true;
      }
      return false;
    },
  };
}
