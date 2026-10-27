/**
 * The Vision command, a repository's (#7272): what the repository is for,
 * read from docs/VISION.md on its default branch with the same `parseVision`
 * MCP `vision` answers with — the purpose, then each pillar of the order of
 * work numbered, then the rules of how it is built. Wrapped to the width at
 * render, never cut mid-word. A repository without the document says so in
 * one line (the terminal's own words; MCP `vision` answers with an empty
 * order). Read-only; offered to, and read for, only someone who may read it.
 */

import { canRead, type Repo } from "../../core/repos.ts";
import { NO_VISION, NO_VISION_LINE, type Vision } from "../../core/vision.ts";
import { readDefaultVision } from "../../crew/vision.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Command } from "../app/palette.ts";
import { BOLD, style } from "../term/style.ts";
import { displayWidth, wrap } from "../term/width.ts";
import type { Session } from "../session.ts";
import { Scroll, drawLines, hitScroll } from "./common.ts";

/** What a viewer who may not read the repository sees: what the page's 404 says, nothing of the document. */
export const NOT_FOUND_LINE = "No such repository, or you may not read it.";
const HIDDEN: Vision = { purpose: NOT_FOUND_LINE, order: [], rules: [] };

export interface VisionLine {
  readonly text: string;
  readonly head: boolean;
}

/** `text` wrapped to `width`, the first line led by `lead` and the rest indented under it. */
function hanging(lead: string, text: string, width: number): string[] {
  const indent = displayWidth(lead);
  const pad = " ".repeat(indent);
  return wrap(text, Math.max(1, width - indent)).map((l, i) => (i === 0 ? lead : pad) + l);
}

/** The screen's lines at `width` columns: purpose, numbered pillars, rules. */
export function visionLines(v: Vision, width: number): VisionLine[] {
  const body = (text: string): VisionLine => ({ text, head: false });
  const head = (text: string): VisionLine => ({ text, head: true });
  if (v.purpose === null && v.order.length === 0 && v.rules.length === 0)
    return wrap(NO_VISION_LINE, width).map(body);
  const out: VisionLine[] = [];
  if (v.purpose !== null) out.push(...wrap(v.purpose, width).map(body));
  if (v.order.length > 0) {
    if (out.length > 0) out.push(body(""));
    out.push(head("Order of work"));
    for (const p of v.order) {
      const lead = `${p.n}. `;
      const text = p.text === "" ? p.name : `${p.name}. ${p.text}`;
      out.push(...hanging(lead, text, width).map(body));
    }
  }
  if (v.rules.length > 0) {
    if (out.length > 0) out.push(body(""));
    out.push(head("How we build"));
    for (const r of v.rules) out.push(...hanging("- ", r, width).map(body));
  }
  return out;
}

export function visionScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  const scroll = new Scroll();
  let vision: Vision | undefined;
  let lines: VisionLine[] = [];
  return {
    title: "Vision",
    keys: [binding(["j", "k"], "scroll"), binding(["esc", "q"], "back")],
    async load() {
      // Gated here as well as on the command: the screen is exported, and a
      // viewer who may not read the repository is shown nothing of it.
      vision = canRead(f.db, repo, f.user) ? ((await readDefaultVision(f.app.reposRoot, repo)) ?? NO_VISION) : HIDDEN;
      ctx.invalidate();
    },
    render(area, s) {
      const c = ctx.theme.c;
      // One column for the scrollbar `drawLines` keeps, one for breathing room.
      const width = Math.max(1, area.w - 2);
      lines = vision === undefined ? [{ text: "Reading…", head: false }] : visionLines(vision, width);
      const spans = lines.map((l) => [{ text: l.text, style: l.head ? style(c.accent, c.bg, BOLD) : style(c.fg, c.bg) }]);
      drawLines(s, area, c, scroll, spans);
      hitScroll(ctx, area, scroll, lines.length);
    },
    key(e) {
      if (scroll.key(e, lines.length)) return true;
      if (e.key === "esc" || e.key === "q") {
        ctx.pop();
        return true;
      }
      return false;
    },
  };
}

/** The palette's door on a repository screen, for whoever may read it. */
export function visionCommands(f: Session, ctx: Ctx, repo: Repo | undefined): Command[] {
  if (repo === undefined || !canRead(f.db, repo, f.user)) return [];
  return [
    {
      id: "vision",
      title: `${repo.ownerName}/${repo.name} — Vision`,
      hint: "what it is for, the order of work",
      run: () => ctx.push(visionScreen(f, ctx, repo)),
    },
  ];
}
