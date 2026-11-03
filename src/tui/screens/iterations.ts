/**
 * The Iterations command, a repository's: its fork family's build pins as the
 * web page draws them (`iterationsOf`, `lanesOf`), as an indented list — a run
 * under the build it grew from, its builds beneath. Read-only. Offered to, and
 * read for, only someone who may read the repository; the family is what that
 * viewer may read of it (`canRead`, `visibleForks`), so a guest sees nothing
 * private.
 */

import { canRead, type Repo } from "../../core/repos.ts";
import { iterationsOf, lanesOf, type IterationLane } from "../../core/iterations.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Command } from "../app/palette.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { ListState } from "./common.ts";

export const NOT_FOUND_LINE = "No such repository";
export const NO_ITERATIONS_LINE = "No builds pinned in this family yet.";

export interface IterationLine {
  readonly depth: number;
  readonly text: string;
  /** A run's head, as against one of its builds. */
  readonly head: boolean;
}

/** The family's runs flattened to lines: a head per run, then a line per build. */
export function iterationLines(lanes: readonly IterationLane[]): IterationLine[] {
  const laneOf = new Map<string, IterationLane>();
  for (const l of lanes) for (const b of l.builds) laneOf.set(b.key, l);
  const mainOf = new Map(lanes.filter((l) => l.main).map((l) => [l.repo, l]));
  const depthOf = new Map<IterationLane, number>();
  const depth = (l: IterationLane, guard = 0): number => {
    const got = depthOf.get(l);
    if (got !== undefined) return got;
    const up = l.from !== null ? laneOf.get(l.from) : l.fromRepo !== null ? mainOf.get(l.fromRepo) : undefined;
    const d = up === undefined || up === l || guard > lanes.length ? 0 : depth(up, guard + 1) + 1;
    depthOf.set(l, d);
    return d;
  };
  const out: IterationLine[] = [];
  for (const l of lanes) {
    const d = depth(l);
    const n = l.builds.length;
    out.push({ depth: d, head: true, text: `${l.title}  ${n === 0 ? "no build pinned" : `${String(n)} ${n === 1 ? "build" : "builds"}`}` });
    for (const b of l.builds) out.push({ depth: d + 1, head: false, text: `${b.label}  ${b.at.slice(0, 10)}${b.note === "" ? "" : `  ${b.note}`}` });
  }
  return out;
}

export function iterationsScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  let lines: IterationLine[] | undefined;
  let hidden = false;
  const state = new ListState();
  const screen: Screen = {
    title: "Iterations",
    keys: [binding(["j", "k"], "move"), binding(["esc", "q"], "back")],
    async load() {
      // Gated here as well as on the command: the screen is exported.
      hidden = !canRead(f.db, repo, f.user);
      const forks = hidden ? undefined : await iterationsOf(f.app, f.user, repo);
      lines = forks === undefined ? [] : iterationLines(lanesOf(forks));
      state.clamp(lines.length);
      ctx.invalidate();
    },
    render(area, s) {
      const c = ctx.theme.c;
      const right = area.x + area.w;
      const line = (y: number, x: number, text: string, fg = c.fg) => s.text(area.x + x, area.y + y, truncate(text, Math.max(1, area.w - x)), style(fg, c.bg), right);
      if (hidden) return void line(0, 1, NOT_FOUND_LINE);
      if (lines === undefined) return void line(0, 1, "Reading…");
      if (lines.length === 0) return void line(0, 1, NO_ITERATIONS_LINE);
      const from = state.window(area.h, lines.length);
      for (let i = 0; i < area.h; i++) {
        const l = lines[from + i];
        if (l === undefined) break;
        const picked = from + i === state.index;
        s.text(area.x, area.y + i, picked ? ">" : " ", style(c.accent, c.bg), right);
        line(i, 1 + l.depth * 2, l.text, picked || l.head ? c.fg : c.muted);
      }
    },
    key(e) {
      const n = lines?.length ?? 0;
      if (e.key === "j" || e.key === "down") state.move(1, n);
      else if (e.key === "k" || e.key === "up") state.move(-1, n);
      else if (e.key === "esc" || e.key === "q") ctx.pop();
      else return false;
      ctx.invalidate();
      return true;
    },
  };
  return screen;
}

/** The palette's door on a repository screen, for whoever may read it. */
export function iterationsCommands(f: Session, ctx: Ctx, repo: Repo | undefined): Command[] {
  if (repo === undefined || !canRead(f.db, repo, f.user)) return [];
  return [
    {
      id: "iterations",
      title: `${repo.ownerName}/${repo.name} — Iterations`,
      hint: "its fork family's build pins as a tree of runs",
      run: () => ctx.push(iterationsScreen(f, ctx, repo)),
    },
  ];
}
