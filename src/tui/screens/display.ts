/**
 * A repository's display (`/<owner>/<repo>/display` on the web):
 * its title and layout, then its builds as `displayPage` shows them — a build
 * whose repository the viewer reads names it, any other says "private" and
 * nothing more. Read through the same `displayOf` and `displayItems`, and
 * gated here as well as on the command, since the screen is exported.
 * Whoever writes the repository (`writesDisplay`) sees the builds they could
 * choose instead, `space` ticks one and `s` saves through `chooseBuilds`, the
 * same write the web form and the API make.
 */

import { chooseBuilds, choosableBuilds } from "../../actions/displays.ts";
import { writesDisplay } from "../../display/selections.ts";
import { selectionKeys } from "../../display/items.ts";

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
  // A writer's view: every build they could choose, and which are ticked.
  let choices: string[] | undefined;
  const ticked = new Set<string>();
  let note = "";
  const state = new ListState();
  // What each build reads as, by key, so a choice shows its name.
  const named = new Map<string, string>();
  const read = async (): Promise<void> => {
    const config = canRead(f.db, repo, f.user) ? await displayOf(f.app, repo) : undefined;
    missing = config === undefined;
    if (config !== undefined) {
      head = config.ok ? `${config.value.title} · ${config.value.layout}` : INVALID_TITLE;
      const items = config.ok ? await displayItems(f.app, repo, config.value, f.user) : [];
      lines = config.ok ? items.map(itemLine) : [config.error];
      named.clear();
      for (const it of items) named.set(it.key, itemLine(it));
      choices = undefined;
      if (config.ok && writesDisplay(f.app, repo, f.user)) {
        const chosen = await selectionKeys(f.app, config.value, f.user);
        choices = await choosableBuilds(f.app, config.value, chosen, f.user);
        ticked.clear();
        for (const k of chosen) ticked.add(k);
      }
    }
    state.clamp((choices ?? lines).length);
    ctx.invalidate();
  };
  return {
    title: "Display",
    get keys() {
      return choices === undefined
        ? [binding(["j", "k"], "move"), binding(["esc", "q"], "back")]
        : [binding(["j", "k"], "move"), binding(["space"], "tick"), binding(["s"], "save"), binding(["esc", "q"], "back")];
    },
    load: read,
    render(area, s) {
      const c = ctx.theme.c;
      const right = area.x + area.w;
      const line = (y: number, text: string, fg = c.fg, x = 1) => s.text(area.x + x, area.y + y, truncate(text, Math.max(1, area.w - x)), style(fg, c.bg), right);
      if (missing) return void line(0, NO_DISPLAY_LINE);
      if (head === undefined) return void line(0, "Reading…");
      line(0, head);
      const shown = choices === undefined ? lines : choices.map((k) => `[${ticked.has(k) ? "x" : " "}] ${named.get(k) ?? k}`);
      if (note !== "") line(1, note, c.mutedFg);
      if (shown.length === 0) return void line(1, NO_BUILDS_LINE, c.mutedFg);
      const top = note === "" ? 0 : 1;
      const rows = Math.max(0, area.h - 1 - top);
      const from = state.window(rows, shown.length);
      for (let i = 0; i < rows; i++) {
        const l = shown[from + i];
        if (l === undefined) break;
        const picked = from + i === state.index;
        s.text(area.x, area.y + 1 + top + i, picked ? ">" : " ", style(c.accent, c.bg), right);
        line(1 + top + i, l, picked ? c.fg : c.mutedFg);
      }
    },
    key(e) {
      const n = (choices ?? lines).length;
      if (e.key === "j" || e.key === "down") state.move(1, n);
      else if (e.key === "k" || e.key === "up") state.move(-1, n);
      else if (choices !== undefined && e.key === " ") {
        const k = choices[state.index];
        if (k !== undefined) void (ticked.delete(k) || ticked.add(k));
      } else if (choices !== undefined && e.key === "s") {
        // Chosen builds keep their order; newly ticked ones follow.
        const keys = choices.filter((k) => ticked.has(k));
        void ctx.track(chooseBuilds(f.app, f.user, repo, keys).then(async (done) => {
          note = done.ok ? "Saved." : done.error.kind === "invalid" || done.error.kind === "failed" ? done.error.message : "Not saved.";
          if (done.ok) await read();
          ctx.invalidate();
        }));
      } else if (e.key === "esc" || e.key === "q") ctx.pop();
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
