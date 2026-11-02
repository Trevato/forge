/**
 * The panels pinned to home, in the terminal (#8726): the same list home
 * draws after its KPIs, in its owner's order, read and changed through
 * `actions/board-pins.ts` as the page's Up, Down and Unpin are, so the gate
 * is the action's (a forge admin who is a person, their own pins only) and
 * the palette offers the door only to that person. `<`/`>` move the marked
 * pin, `u` unpins it, `enter` opens its board. A change from any door (home,
 * a board, the API, the MCP) redraws this list, and one made here redraws home.
 */

import { listPinned, movePinned, PINS_EVENT, unpinPanel, type Pinned } from "../../actions/board-pins.ts";
import { showBoard } from "../../actions/boards.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { emptyState } from "../ui/widgets.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { boardScreen, plain } from "./boards.ts";
import { ListState, drawList, hitList, live, plural, runAsync, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

const mayPin = (f: Session): boolean => f.user?.isAdmin === true && f.user.kind !== "agent";

/** One pin as a list row: the panel's title, then its board and chart. */
export const pinRow = (p: Pinned): ListRow => ({ title: plain(p.panel.title), secondary: `${plain(p.board.title)} · ${p.panel.chart}` });

export function homePinsScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  let pins: Pinned[] = [];
  const read = async (): Promise<void> => {
    const listed = await listPinned(f.app, f.user);
    pins = listed.ok ? listed.value : [];
    state.clamp(pins.length);
    ctx.invalidate();
  };
  const act = (by?: -1 | 1): void => {
    const p = pins[state.index];
    if (p === undefined) return;
    runAsync(ctx, async () => {
      const done = by === undefined ? unpinPanel(f.app, f.user, p.slug, p.title) : movePinned(f.app, f.user, p.slug, p.title, by);
      if (done.ok && by !== undefined) state.index = Math.max(0, Math.min(pins.length - 1, state.index + by));
      ctx.toast(done.ok ? (by === undefined ? "unpinned" : "moved on home") : "could not change that pin", done.ok ? "success" : "danger");
      await read();
    });
  };
  const open = (index: number): void => {
    const p = pins[index];
    if (p === undefined) return;
    runAsync(ctx, async () => {
      const shown = await showBoard(f.app, f.user, p.slug);
      if (!shown.ok) ctx.toast("That board is gone", "default");
      else ctx.push(boardScreen(ctx, f, p.slug, shown.value));
    });
  };
  return {
    title: "Pinned panels",
    keys: [binding(["j", "k"], "move"), binding(["<", ">"], "move pin"), binding(["u"], "unpin"), binding(["enter"], "open board")],
    async load(signal) {
      await read();
      live(f, signal, { kinds: [PINS_EVENT], where: (e) => e.actorId === f.user?.id }, read);
    },
    render(area, s) {
      const c = ctx.theme.c;
      const [head, body] = split(area, "v", [len(1), fill(1)]);
      s.text(head!.x, head!.y, truncate(`${plural(pins.length, "panel")} pinned to home, in its order`, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      if (pins.length === 0) {
        emptyState(s, body!, c, { title: "Nothing pinned", body: "Open Boards, mark a panel with [ or ], and press p." });
        return;
      }
      drawList(s, body!, c, state, pins.map(pinRow));
      hitList(ctx, body!, state, pins.length, { open });
    },
    key(e) {
      if (!mayPin(f)) return false;
      if (state.key(e, pins.length)) return true;
      if (e.key === "enter") return open(state.index), true;
      if (e.key === "u") return act(), true;
      if (e.key === "<" || e.key === ">") return act(e.key === ">" ? 1 : -1), true;
      return false;
    },
  };
}

/** Home's pinned panels, as the page gates them: a forge admin who is a person. */
export const entry: PaletteEntry = {
  id: "home-pins",
  title: "Pinned panels",
  hint: "the panels pinned to home: reorder and unpin",
  after: ["boards"],
  offered: mayPin,
  run: (session, ctx) => ctx.push(homePinsScreen(session, ctx)),
};
