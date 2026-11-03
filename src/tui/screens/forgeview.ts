/**
 * The forge view (`GET /api/v1/forge/view`) as a screen: the apps, running,
 * queued and waiting counts it carries, the first apps and runs, and the Foundry address when the
 * reader has a door to it (`foundryHref`). Enter opens Foundry on the web.
 * Signed-in readers only; the numbers are the view's own, read once when the
 * screen opens (not per frame or key), so it is a picture, not a live board.
 */

import { foundryHref } from "../../actions/foundry_door.ts";
import { forgeView } from "../../actions/forge_view.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { openOnWeb } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

/** Apps and runs the screen lists below the counts; the rest is `counts`. */
const SHOWN = 12;

/** What the screen shows for this session, read once: when it opens. */
export function forgeViewLines(f: Session): { lines: string[]; foundry: string | undefined } {
  const user = f.user;
  if (user === undefined) return { lines: ["Sign in to see the forge."], foundry: undefined };
  const { counts, apps, runs } = forgeView({ app: f.app }, user);
  const foundry = foundryHref(f.app, user);
  const working = runs.filter((r) => r.run !== null);
  return {
    foundry,
    lines: [
      `${counts.apps} apps · ${counts.running} running · ${counts.queued} queued · ${counts.waiting} waiting for a person`,
      foundry === undefined ? "Foundry is not installed here." : `Foundry: ${foundry}  (enter opens it)`,
      "",
      ...(working.length === 0 ? ["No runs right now."] : ["Runs:"]),
      ...working.slice(0, SHOWN).map((r) => `  ${r.app}  ${r.state}  ${r.who}: ${r.on}`),
      "",
      "Apps:",
      ...apps.slice(0, SHOWN).map((a) => `  ${a.app}  ${a.access}${a.running + a.queued > 0 ? `  ${a.running} running, ${a.queued} queued` : ""}`),
      ...(counts.apps > SHOWN ? [`  … and ${counts.apps - SHOWN} more`] : []),
    ],
  };
}

export function forgeViewScreen(f: Session, ctx: Ctx): Screen {
  const { lines, foundry } = forgeViewLines(f);
  return {
    title: "Forge view",
    keys: [binding(["enter"], "open Foundry on the web")],
    render(area, s) {
      const c = ctx.theme.c;
      lines.forEach((line, i) => {
        if (i < area.h) s.text(area.x, area.y + i, truncate(line, area.w), style(c.mutedFg, c.bg), area.x + area.w);
      });
    },
    key(e) {
      if (e.ctrl || e.alt || e.key !== "enter") return false;
      if (foundry === undefined) return false;
      openOnWeb(f, ctx, foundry, "Foundry");
      return true;
    },
  };
}

export const entry: PaletteEntry = {
  id: "forge-view",
  title: "Forge view",
  hint: "the forge's counts, and Foundry when it is installed",
  after: ["now"],
  offered: (session) => session.user !== undefined,
  run: (session, ctx) => ctx.push(forgeViewScreen(session, ctx)),
};
