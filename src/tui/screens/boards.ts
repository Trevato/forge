/**
 * `/boards` in the terminal (#1817): the boards a forge admin who is a person
 * keeps, then one board's panels as text. It reads through the same
 * `listAllBoards` and `showBoard` the page and the API do, so the gate is the
 * action's (an agent or anyone else is told nothing); the palette offers the
 * door only to that person. Reading only, but for pins: a chart is not drawn, a panel is said
 * as its title, chart, size and the query that feeds it. `[`/`]` mark a panel,
 * `p` pins or unpins it to home and `<`/`>` move a pinned one (`actions/board-pins.ts`).
 */

import type { Board } from "../../boards/store.ts";
import { listPinned, movePinned, pinPanel, unpinPanel } from "../../actions/board-pins.ts";
import { listAllBoards, showBoard } from "../../actions/boards.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { split, fill, len } from "../ui/layout.ts";
import { emptyState } from "../ui/widgets.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { ListState, Scroll, drawList, drawLines, hitList, hitScroll, metaOf, plural, runAsync, type ListRow } from "./common.ts";

/** One line of plain text: a title or a query value may carry escapes the terminal must not obey. */
export const plain = (text: string): string =>
  // eslint-disable-next-line no-control-regex
  text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();

export interface BoardRow extends ListRow {
  readonly slug: string;
}

/** The boards as rows; nothing for anyone the action refuses. */
export async function boardRows(session: Session): Promise<BoardRow[]> {
  const listed = await listAllBoards(session.app, session.user);
  if (!listed.ok) return [];
  return listed.value.map((b) => ({
    slug: b.slug,
    title: plain(b.board.title),
    secondary: b.slug,
    meta: metaOf(plural(b.board.panels.length, "panel"), b.board.range),
  }));
}

/** A board, panel by panel, as lines of text; the panel at `at` is marked, and a pinned one says so. */
export function boardLines(board: Board, at = -1, pinned: readonly string[] = []): string[] {
  const lines = [
    plain(board.title),
    `range ${board.range} · refresh ${board.refresh} · ${plural(board.panels.length, "panel")}`,
  ];
  for (const [i, p] of board.panels.entries()) {
    const query = Object.entries(p.query)
      .map(([k, v]) => `${plain(k)}=${plain(typeof v === "string" ? v : JSON.stringify(v))}`)
      .join(" ");
    lines.push("", `${i === at ? "▸ " : ""}${plain(p.title)}${pinned.includes(p.title) ? "  [pinned to home]" : ""}`, `  ${p.chart} · ${p.w}×${p.h}`, `  ${query === "" ? "no query" : query}`);
  }
  return lines;
}

function boardScreen(ctx: Ctx, f: Session, slug: string, board: Board): Screen {
  const scroll = new Scroll();
  let at = board.panels.length > 0 ? 0 : -1;
  let pinned: string[] = [];
  let lines = boardLines(board, at, pinned);
  const read = async (): Promise<void> => {
    const listed = await listPinned(f.app, f.user);
    pinned = listed.ok ? listed.value.filter((p) => p.slug === slug).map((p) => p.title) : [];
    lines = boardLines(board, at, pinned);
    ctx.invalidate();
  };
  /** Pin the marked panel, or unpin it when it is; `by` moves a pinned one in the home order. */
  const act = (by?: -1 | 1): void => {
    const panel = board.panels[at];
    if (panel === undefined) return;
    runAsync(ctx, async () => {
      const there = pinned.includes(panel.title);
      const done =
        by !== undefined ? movePinned(f.app, f.user, slug, panel.title, by)
        : there ? unpinPanel(f.app, f.user, slug, panel.title)
        : await pinPanel(f.app, f.user, slug, panel.title);
      ctx.toast(done.ok ? (by !== undefined ? "moved on home" : there ? "unpinned" : "pinned to home") : done.error === "too_many" ? "too many pins" : done.error === "not_found" && by !== undefined ? "that panel is not pinned" : "could not pin that", done.ok ? "success" : "danger");
      await read();
    });
  };
  return {
    title: plain(board.title),
    keys: [
      binding(["j", "k"], "scroll"), binding(["[", "]"], "panel"), binding(["p"], "pin / unpin"),
      binding(["<", ">"], "move pin"), binding(["esc", "q"], "back"),
    ],
    load: read,
    render(area, s) {
      const c = ctx.theme.c;
      const spans = lines.map((text, i) => [{ text, style: style(i === 0 ? c.fg : c.mutedFg, c.bg) }]);
      drawLines(s, area, c, scroll, spans);
      hitScroll(ctx, area, scroll, lines.length);
    },
    key(e) {
      if (scroll.key(e, lines.length)) return true;
      if (e.key === "[" || e.key === "]") {
        if (board.panels.length > 0) at = (at + (e.key === "]" ? 1 : board.panels.length - 1)) % board.panels.length;
        lines = boardLines(board, at, pinned);
        return true;
      }
      if (e.key === "p") return act(), true;
      if (e.key === "<" || e.key === ">") return act(e.key === ">" ? 1 : -1), true;
      if (e.key === "esc" || e.key === "q") {
        ctx.pop();
        return true;
      }
      return false;
    },
  };
}

export function boardsScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  let rows: BoardRow[] = [];
  const read = async (): Promise<void> => {
    rows = await boardRows(f);
    state.clamp(rows.length);
  };
  const open = (index: number): void => {
    const row = rows[index];
    if (row === undefined) return;
    runAsync(ctx, async () => {
      const shown = await showBoard(f.app, f.user, row.slug);
      if (!shown.ok) ctx.toast("That board is gone", "default");
      else ctx.push(boardScreen(ctx, f, row.slug, shown.value));
    });
  };
  return {
    title: "Boards",
    keys: [binding(["j", "k"], "move"), binding(["enter"], "open"), binding(["r"], "refresh")],
    load: read,
    render(area, s) {
      const c = ctx.theme.c;
      const [head, body] = split(area, "v", [len(1), fill(1)]);
      s.text(head!.x, head!.y, truncate(plural(rows.length, "board"), head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      if (rows.length === 0) {
        emptyState(s, body!, c, {
          title: "No boards yet",
          body: "Make one on the web at /boards; it shows up here.",
        });
        return;
      }
      drawList(s, body!, c, state, rows);
      hitList(ctx, body!, state, rows.length, { open });
    },
    key(e) {
      if (state.key(e, rows.length)) return true;
      if (e.key === "enter") {
        open(state.index);
        return true;
      }
      if (e.key === "r") {
        runAsync(ctx, async () => {
          await read();
          ctx.invalidate();
        });
        return true;
      }
      return false;
    },
  };
}
