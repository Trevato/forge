/**
 * The space in the terminal (#10444): the plane the page draws, as text. The
 * same `spaceOf` the page and `space.json` read, so a guest sees what is
 * public and an admin everything. Per pillar: its counts, its issues by state,
 * then who of the crew is on what, and the week's landings.
 */

import type { Repo } from "../../core/repos.ts";
import { spaceOf } from "../../web/space_read.ts";
import type { ClusterRow, IssueRow, Region, State } from "../../web/space_model.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { wrap } from "../term/width.ts";
import { Scroll } from "./common.ts";

const NAMES: Record<State, string> = { ready: "Ready", building: "Building", review: "In review", waiting: "Waiting", landed: "Landed" };

/** The space as text lines, wrapped to `width`. */
export function spaceLines(space: Record<string, unknown>, width = 80): string[] {
  const w = Math.max(20, width);
  const regions = space.regions as Region[];
  const clusters = space.clusters as ClusterRow[];
  const states = space.states as State[];
  const issues = space.issues as IssueRow[];
  const crew = space.crew as { name: string; runs: [number, number, number][] }[];
  const now = space.now as number;
  const out: string[] = [];
  regions.forEach((r, ri) => {
    out.push(`${r.name}  ${r.open} open, ${r.ready} ready, ${r.landed} landed this week${r.moving ? "" : ", still"}`);
    const by = new Map<State, IssueRow[]>();
    for (const row of issues) {
      const c = clusters[row[1]];
      if (c === undefined || c[0] !== ri) continue;
      const st = states[c[1]!]!;
      by.set(st, [...(by.get(st) ?? []), row]);
    }
    for (const st of states) {
      const rows = by.get(st);
      if (rows === undefined) continue;
      out.push(`  ${NAMES[st]} (${rows.length})`);
      for (const row of rows) out.push(...wrap(`    #${row[0]} ${row[6]}${row[7] ? ` (pull #${row[7]}${row[12] ? `, checks ${row[12]}` : ""})` : ""}`, w));
    }
    out.push("");
  });
  const on = crew.flatMap((m) => {
    const cur = m.runs.find((run) => run[1] <= now && (run[2] === 0 || run[2] > now));
    return cur === undefined ? [] : [`  ${m.name} is on #${cur[0]}`];
  });
  out.push("The crew", ...(on.length === 0 ? ["  Nobody is building right now."] : on), "");
  const landed = issues.filter((row) => row[5] > 0).sort((a, b) => b[5] - a[5]);
  out.push(`Landed this week (${landed.length})`, ...landed.flatMap((row) => wrap(`  #${row[0]} ${row[6]}`, w)));
  return out;
}

export function spaceScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  const scroll = new Scroll();
  let lines: string[] = [];
  return {
    title: `Space · ${repo.ownerName}/${repo.name}`,
    keys: [binding(["j", "k"], "scroll"), binding(["esc"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      lines = spaceLines(spaceOf(f.app, repo, f.user), area.w - 4);
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
