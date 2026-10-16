/**
 * `/boards` in the terminal (#1817): the boards a forge admin who is a person
 * keeps, then one board's panels as text. It reads through the same
 * `listAllBoards` and `showBoard` the page and the API do, so the gate is the
 * action's (an agent or anyone else is told nothing); the palette offers the
 * door only to that person. Read-only: a chart is not drawn, a panel is said
 * as its title, chart, size and the query that feeds it.
 */

import type { Board } from "../../boards/store.ts";
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
const plain = (text: string): string =>
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

/** A board, panel by panel, as lines of text. */
export function boardLines(board: Board): string[] {
  const lines = [
    plain(board.title),
    `range ${board.range} · refresh ${board.refresh} · ${plural(board.panels.length, "panel")}`,
  ];
  for (const p of board.panels) {
    const query = Object.entries(p.query)
      .map(([k, v]) => `${plain(k)}=${plain(typeof v === "string" ? v : JSON.stringify(v))}`)
      .join(" ");
    lines.push("", plain(p.title), `  ${p.chart} · ${p.w}×${p.h}`, `  ${query === "" ? "no query" : query}`);
  }
  return lines;
}

function boardScreen(ctx: Ctx, board: Board): Screen {
  const scroll = new Scroll();
  const lines = boardLines(board);
  return {
    title: plain(board.title),
    keys: [binding(["j", "k"], "scroll"), binding(["esc", "q"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      const spans = lines.map((text, i) => [{ text, style: style(i === 0 ? c.fg : c.mutedFg, c.bg) }]);
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
      else ctx.push(boardScreen(ctx, shown.value));
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
