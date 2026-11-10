/**
 * The roadmap in the terminal (#10303): the same model the map page, the API
 * and the MCP read (`web/roadmap.ts`), as scrolling text lines. The reader is
 * the session's person, so a guest sees what is public and only a writer
 * gets Needs you.
 */

import type { Repo } from "../../core/repos.ts";
import { paceSentence, roadmapOf, type Roadmap, type RoadmapIssue } from "../../web/roadmap.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { wrap } from "../term/width.ts";
import { Scroll } from "./common.ts";

const issueLine = (i: RoadmapIssue): string =>
  `    #${i.number} ${i.title}${i.pull === undefined ? "" : ` (pull #${i.pull})`}${i.blockedBy === undefined ? "" : ` (waits for #${i.blockedBy.number})`}${i.moved ? " (moved)" : ""}`;

/** The roadmap as text lines, wrapped to `width`. */
export function roadmapLines(road: Roadmap, width = 80): string[] {
  const w = Math.max(20, width);
  const out = [...wrap(paceSentence(road), w), ""];
  if (road.needsYou.length > 0) {
    out.push("Needs you");
    for (const n of road.needsYou) out.push(...wrap(`  ${n.text} (${n.pull ? "pull" : "issue"} #${n.number}: ${n.action})`, w));
    out.push("");
  }
  for (const p of road.pillars) {
    const state = p.state === "done" ? "done" : p.total === 0 ? "nothing yet" : `${p.done} of ${p.total} done`;
    out.push(`${p.name}  ${state}${p.state === "current" ? `  ${p.etaAt === null ? "no date yet" : `around ${p.etaAt.slice(0, 10)}`}` : ""}`);
    if (p.state === "future") continue;
    const g = p.groups;
    for (const [title, rows] of [
      ["Building", g.building],
      ["Up next", g.upNext],
      ["Waiting on a pull", g.waiting],
      ["Blocked", g.blocked],
      ["Done this week", g.doneThisWeek],
    ] as const) {
      if (rows.length === 0) continue;
      out.push(`  ${title}`);
      for (const i of rows) out.push(issueLine(i));
    }
  }
  return out;
}

export function roadmapScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  const scroll = new Scroll();
  let lines: string[] = [];
  return {
    title: `Roadmap · ${repo.ownerName}/${repo.name}`,
    keys: [binding(["j", "k"], "scroll"), binding(["esc"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      const road = roadmapOf(f.app.db, repo, f.user);
      lines = road === undefined ? ["This repository names no pillars."] : roadmapLines(road, area.w - 4);
      const from = scroll.window(area.h, lines.length);
      for (let i = 0; i < area.h; i++) {
        const line = lines[from + i];
        if (line !== undefined) s.text(area.x + 1, area.y + i, line, style(c.fg, c.bg), area.x + area.w);
      }
    },
    key(e) {
      if (e.key === "esc" || e.key === "q") {
        ctx.pop();
        return true;
      }
      return scroll.key(e, lines.length);
    },
  };
}
