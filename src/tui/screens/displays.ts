/**
 * Displays (/displays on the web): every display the viewer may read, one
 * row each — title, layout, repository, showcased demo count — from the same
 * `listedDisplays` call as the page. Read only.
 */

import { DISPLAYS_NOTE, INVALID_TITLE, listedDisplays, type ListedDisplay } from "../../display/known.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, drawList, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

/** One display as a row: its title (or that its file is invalid), then layout, repository and demos. */
export function displayRow(d: ListedDisplay): ListRow {
  const name = `${d.repo.ownerName}/${d.repo.name}`;
  if (!d.config.ok) return { title: INVALID_TITLE, secondary: `${name} · no layout · no demos` };
  const demos = d.demos ?? 0;
  return { title: d.config.value.title, secondary: `${d.config.value.layout} · ${name} · ${demos} ${demos === 1 ? "demo" : "demos"}` };
}

export function displaysScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  let shown: ListedDisplay[] | undefined;
  return {
    title: "Displays",
    keys: [binding(["j", "k"], "move cursor")],
    async load() {
      shown = await listedDisplays(f.app, f.user);
    },
    render(area, s) {
      const c = ctx.theme.c;
      const [head, list] = split(area, "v", [len(1), fill(1)]);
      const text = shown === undefined ? "Loading displays…" : shown.length === 0 ? DISPLAYS_NOTE : `${shown.length} displays you may read`;
      s.text(head!.x, head!.y, truncate(text, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, list!, c, state, (shown ?? []).map(displayRow));
    },
    key(e) {
      return state.key(e, shown?.length ?? 0);
    },
  };
}

/** Displays, as /displays lists them: anyone signed in. */
export const entry: PaletteEntry = {
  id: "displays",
  title: "Displays",
  hint: "the displays you may read",
  after: ["repos"],
  offered: (session) => session.user !== undefined,
  run: (session, ctx) => ctx.push(displaysScreen(session, ctx)),
};
