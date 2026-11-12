/**
 * The Vision command, a repository's (#7272): what the repository is for,
 * read from docs/VISION.md on its default branch with the same `parseVision`
 * MCP `vision` answers with — the purpose, then each pillar of the order of
 * work numbered, then the rules of how it is built. Wrapped to the width at
 * render, never cut mid-word. A repository without the document says so in
 * one line (the terminal's own words; MCP `vision` answers with an empty
 * order). Under the rules, for whoever may read the repository's settings,
 * the open direction issue (`#N title`) and its parts, as MCP `vision`
 * answers `directionParts`; Enter opens the issue. Read-only; offered to,
 * and read for, only someone who may read it.
 */

import { canAdmin, canRead, getRepoById, type Repo } from "../../core/repos.ts";
import { getIssueById } from "../../core/issues.ts";
import { NO_VISION, NO_VISION_LINE, type Vision } from "../../core/vision.ts";
import { directionStall } from "../../crew/planner.ts";
import { directionParts, readDefaultVision, type DirectionPart } from "../../crew/vision.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Command } from "../app/palette.ts";
import { BOLD, style } from "../term/style.ts";
import { displayWidth, wrap } from "../term/width.ts";
import type { Session } from "../session.ts";
import { Scroll, drawLines, hitScroll } from "./common.ts";
import { issueScreen } from "./issue.ts";
import { local } from "./where.ts";

/** What a viewer who may not read the repository sees: what the page's 404 says, nothing of the document. */
export const NOT_FOUND_LINE = "No such repository, or you may not read it.";
const HIDDEN: Vision = { purpose: NOT_FOUND_LINE, order: [], rules: [] };

/** The open direction issue and the parts of the direction, as MCP `vision` reads them. */
export interface Direction {
  readonly number: number;
  readonly title: string;
  readonly parts: readonly DirectionPart[];
}

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
export function visionLines(v: Vision, width: number, direction?: Direction, stall?: string): VisionLine[] {
  const body = (text: string): VisionLine => ({ text, head: false });
  const head = (text: string): VisionLine => ({ text, head: true });
  const empty = v.purpose === null && v.order.length === 0 && v.rules.length === 0;
  if (empty && direction === undefined && stall === undefined) return wrap(NO_VISION_LINE, width).map(body);
  const out: VisionLine[] = empty ? wrap(NO_VISION_LINE, width).map(body) : [];
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
  if (direction !== undefined) {
    if (out.length > 0) out.push(body(""));
    out.push(head("Direction"));
    out.push(...hanging(`#${direction.number} `, direction.title, width).map(body));
    for (const p of direction.parts) {
      out.push(body(""));
      out.push(...wrap(p.text, width).map(body));
    }
  }
  if (stall !== undefined) {
    if (out.length > 0) out.push(body(""));
    out.push(head("Direction"));
    out.push(...wrap(stall, width).map(body));
  }
  return out;
}

/** Why a saved direction has no issue, for someone who may read the settings; undefined otherwise. */
function readStall(f: Session, repo: Repo): string | undefined {
  const fresh = getRepoById(f.db, repo.id) ?? repo;
  return canAdmin(f.db, fresh, f.user) ? (directionStall(f.app, fresh) ?? undefined) : undefined;
}

/** The open direction issue and its parts, for someone who may read the settings; undefined otherwise. */
function readDirection(f: Session, repo: Repo): Direction | undefined {
  const fresh = getRepoById(f.db, repo.id) ?? repo;
  if (!canAdmin(f.db, fresh, f.user) || fresh.directionIssueId === null) return undefined;
  const issue = getIssueById(f.db, fresh.directionIssueId);
  if (!issue || issue.state !== "open") return undefined;
  return { number: issue.number, title: issue.title, parts: directionParts(fresh.autonomyDirection) };
}

export function visionScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  const scroll = new Scroll();
  let vision: Vision | undefined;
  let direction: Direction | undefined;
  let stall: string | undefined;
  let lines: VisionLine[] = [];
  return {
    title: "Vision",
    keys: [binding(["j", "k"], "scroll"), binding(["enter"], "open direction"), binding(["esc", "q"], "back")],
    async load() {
      // Gated here as well as on the command: the screen is exported, and a
      // viewer who may not read the repository is shown nothing of it.
      vision = canRead(f.db, repo, f.user) ? ((await readDefaultVision(f.app.reposRoot, repo)) ?? NO_VISION) : HIDDEN;
      direction = vision === HIDDEN ? undefined : readDirection(f, repo);
      stall = vision === HIDDEN ? undefined : readStall(f, repo);
      ctx.invalidate();
    },
    render(area, s) {
      const c = ctx.theme.c;
      // One column for the scrollbar `drawLines` keeps, one for breathing room.
      const width = Math.max(1, area.w - 2);
      lines = vision === undefined ? [{ text: "Reading…", head: false }] : visionLines(vision, width, direction, stall);
      const spans = lines.map((l) => [{ text: l.text, style: l.head ? style(c.accent, c.bg, BOLD) : style(c.fg, c.bg) }]);
      drawLines(s, area, c, scroll, spans);
      hitScroll(ctx, area, scroll, lines.length);
    },
    key(e) {
      if (scroll.key(e, lines.length)) return true;
      if (e.key === "enter" && direction !== undefined) {
        ctx.push(issueScreen(f, ctx, local(f, repo), direction.number));
        return true;
      }
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
