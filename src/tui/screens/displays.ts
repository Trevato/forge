/**
 * Displays (/displays on the web): every display the viewer may read, one
 * row each — title, layout, repository, showcased demo count — from the same
 * bounded `listedDisplaysWithin` call as the page: a cold cache answers with
 * what is kept after `listWait.ms`, says it is still reading, and fills in
 * the rest when the read finishes. Read only.
 */

import { DISPLAYS_NOTE, DISPLAYS_READING, DISPLAYS_SENTENCE, INVALID_TITLE, listedDisplays, listedDisplaysWithin, listWait, type ListedDisplay } from "../../display/known.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate, wrap } from "../term/width.ts";
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

/**
 * `rest` is the read that finishes a cold list behind the screen; a test
 * passes one it holds, to see the screen while it is still reading.
 */
export function displaysScreen(f: Session, ctx: Ctx, rest: () => Promise<ListedDisplay[]> = () => listedDisplays(f.app, f.user)): Screen {
  const state = new ListState();
  let shown: ListedDisplay[] | undefined;
  let reading = false;
  return {
    title: "Displays",
    keys: [binding(["j", "k"], "move cursor")],
    async load() {
      const first = await listedDisplaysWithin(f.app, f.user, listWait.ms);
      shown = first.rows;
      reading = !first.complete;
      if (!reading) return;
      // The rest finishes behind the screen; the kept reads make this call cheap.
      void rest()
        .then((rows) => {
          shown = rows;
          reading = false;
          ctx.invalidate();
        })
        .catch(() => undefined);
    },
    render(area, s) {
      const c = ctx.theme.c;
      // The sentence over two rows: at 80 columns it does not fit one.
      const [what, head, list] = split(area, "v", [len(2), len(1), fill(1)]);
      // Narrower than two rows hold, the second row takes the rest and truncates.
      const lines = wrap(DISPLAYS_SENTENCE, what!.w);
      const rows = [lines[0] ?? "", lines.slice(1).join(" ")];
      rows.forEach((line, i) => s.text(what!.x, what!.y + i, truncate(line, what!.w), style(c.mutedFg, c.bg), what!.x + what!.w));
      const text =
        shown === undefined
          ? "Loading displays…"
          : reading
            ? DISPLAYS_READING
            : shown.length === 0
              ? DISPLAYS_NOTE
              : `${shown.length} displays you may read`;
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
