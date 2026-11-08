/**
 * `/packs` in the terminal: the premade forges this forge ships, one pack's
 * contents (apps, crew), the commands that deploy it and what happens to a
 * stranger's pull. Words come from `src/packs/words.ts`, the same the web page
 * prints. Anyone may open it; it reads the catalog, nothing of the forge's.
 */

import { catalog } from "../../packs/catalog.ts";
import type { Pack } from "../../packs/pack.ts";
import { BRINGS_WORDS, deployCommands, STRANGER_WORDS } from "../../packs/words.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate, wrap } from "../term/width.ts";
import { Scroll } from "./common.ts";
import type { Session } from "../session.ts";

/** One pack as text lines: what it brings, the commands, and the stranger's way in. */
export function packLines(p: Pack, origin: string | undefined, width = 80): string[] {
  const w = Math.max(20, width);
  return [
    `${p.title} ${p.version}`,
    ...wrap(p.description, w),
    "",
    "Apps",
    ...p.apps.map((a) => `  ${a.name}  ${a.source}`),
    ...(p.crew.length === 0 ? [] : ["", "Crew", ...p.crew.map((c) => `  ${c.username}  ${c.roles.join(", ")}`)]),
    "",
    ...wrap(BRINGS_WORDS, w),
    "",
    "Deploy it on your own machine",
    ...deployCommands(p, origin).map((l) => `  ${l}`),
    "",
    "Help build these apps",
    ...STRANGER_WORDS.flatMap((t) => [...wrap(t, w), ""]).slice(0, -1),
  ];
}

function packScreen(ctx: Ctx, p: Pack, origin: string | undefined): Screen {
  const scroll = new Scroll();
  let lines: string[] = [];
  return {
    title: `${p.title} pack`,
    keys: [binding(["j", "k"], "scroll"), binding(["esc"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      lines = packLines(p, origin, area.w - 4);
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

export function packsScreen(ctx: Ctx, origin: string | undefined): Screen {
  const { packs } = catalog();
  let at = 0;
  return {
    title: "Forge packs",
    keys: [binding(["j", "k"], "move"), binding(["enter"], "open"), binding(["esc"], "close")],
    render(area, s) {
      const c = ctx.theme.c;
      s.text(area.x + 1, area.y, "Forge packs: a whole forge to start from", style(c.mutedFg, c.bg), area.x + area.w);
      packs.forEach((p, i) => {
        const on = i === at;
        const row = `${on ? "> " : "  "}${p.title}  v${p.version}  ${p.apps.length} apps, ${p.crew.length} crew  ${p.description}`;
        if (2 + i < area.h) s.text(area.x + 1, area.y + 2 + i, truncate(row, area.w - 2), on ? style(c.accent, c.bg) : style(c.fg, c.bg), area.x + area.w);
      });
    },
    key(e) {
      if (e.ctrl || e.alt) return false;
      if (e.key === "esc" || e.key === "q") ctx.pop();
      else if (e.key === "j" || e.key === "down") at = Math.min(packs.length - 1, at + 1);
      else if (e.key === "k" || e.key === "up") at = Math.max(0, at - 1);
      else if (e.key === "enter") {
        const p = packs[at];
        if (p !== undefined) ctx.push(packScreen(ctx, p, origin));
      } else return false;
      return true;
    },
  };
}

export const packsCommand = (session: Session, ctx: Ctx) => ({
  id: "packs",
  title: "Forge packs",
  hint: "premade forges to deploy, and how to help build their apps",
  run: () => ctx.push(packsScreen(ctx, session.app.config.url)),
});
