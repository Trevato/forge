/**
 * A repository's display (`/<owner>/<repo>/display` on the web), read only:
 * its title and layout, then its builds as `displayPage` shows them — a build
 * whose repository the viewer reads names it, any other says "private" and
 * nothing more. Read through the same `displayOf` and `displayItems`, and
 * gated here as well as on the command, since the screen is exported.
 */

import { canRead, type Repo } from "../../core/repos.ts";
import { displayItems, type DisplayItem } from "../../display/items.ts";
import { INVALID_TITLE, displayOf } from "../../display/known.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Command } from "../app/palette.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { ListState } from "./common.ts";

export const NO_DISPLAY_LINE = "No display here";
export const NO_BUILDS_LINE = "This display shows no builds yet.";

/** One build as a line: name and version, then its repository, or "private". */
export const itemLine = (it: DisplayItem): string =>
  `${it.demo.name} ${it.demo.version}  ${it.open ? `${it.repo.ownerName}/${it.repo.name}` : "private"}`;

export function displayScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  let head: string | undefined;
  let lines: string[] = [];
  let missing = false;
  const state = new ListState();
  return {
    title: "Display",
    keys: [binding(["j", "k"], "move"), binding(["esc", "q"], "back")],
    async load() {
      const config = canRead(f.db, repo, f.user) ? await displayOf(f.app, repo) : undefined;
      missing = config === undefined;
      if (config !== undefined) {
        head = config.ok ? `${config.value.title} · ${config.value.layout}` : INVALID_TITLE;
        lines = config.ok ? (await displayItems(f.app, repo, config.value, f.user)).map(itemLine) : [config.error];
      }
      state.clamp(lines.length);
      ctx.invalidate();
    },
    render(area, s) {
      const c = ctx.theme.c;
      const right = area.x + area.w;
      const line = (y: number, text: string, fg = c.fg, x = 1) => s.text(area.x + x, area.y + y, truncate(text, Math.max(1, area.w - x)), style(fg, c.bg), right);
      if (missing) return void line(0, NO_DISPLAY_LINE);
      if (head === undefined) return void line(0, "Reading…");
      line(0, head);
      if (lines.length === 0) return void line(1, NO_BUILDS_LINE, c.mutedFg);
      const rows = Math.max(0, area.h - 1);
      const from = state.window(rows, lines.length);
      for (let i = 0; i < rows; i++) {
        const l = lines[from + i];
        if (l === undefined) break;
        const picked = from + i === state.index;
        s.text(area.x, area.y + 1 + i, picked ? ">" : " ", style(c.accent, c.bg), right);
        line(1 + i, l, picked ? c.fg : c.mutedFg);
      }
    },
    key(e) {
      const n = lines.length;
      if (e.key === "j" || e.key === "down") state.move(1, n);
      else if (e.key === "k" || e.key === "up") state.move(-1, n);
      else if (e.key === "esc" || e.key === "q") ctx.pop();
      else return false;
      ctx.invalidate();
      return true;
    },
  };
}

/** The palette's door on a repository screen, for whoever may read it. */
export function displayCommands(f: Session, ctx: Ctx, repo: Repo | undefined): Command[] {
  if (repo === undefined || !canRead(f.db, repo, f.user)) return [];
  return [
    {
      id: "display",
      title: `${repo.ownerName}/${repo.name} — Display`,
      hint: "the builds its display.json shows",
      run: () => ctx.push(displayScreen(f, ctx, repo)),
    },
  ];
}
