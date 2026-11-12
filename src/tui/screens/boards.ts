/**
 * `/boards` in the terminal (#1817): the boards a forge admin who is a person
 * keeps, then one board's panels as text. It reads through the same
 * `listAllBoards` and `showBoard` the page and the API do, so the gate is the
 * action's (an agent or anyone else is told nothing); the palette offers the
 * door only to that person. `n` makes a board, `c` copies the marked one, `e` renames it and `g` sets
 * its range (`changeBoard`; `home` still jumps to the top), and `D` deletes it after `y/n`
 * (`actions/boards.ts`, as the page does). Otherwise reading, but for pins: a chart is not drawn, a panel is said
 * as its title, chart, size and the query that feeds it, then what `panelData` reads for it
 * (the page's and the API's door): a time panel's last bucket and its step, else its row count. `[`/`]` mark a panel,
 * `p` pins or unpins it to home and `<`/`>` move a pinned one (`actions/board-pins.ts`).
 */

import { formatValue } from "../../boards/chart.ts";
import { panelData, type PanelData } from "../../boards/panel_data.ts";
import { RANGES, type Board } from "../../boards/store.ts";
import { listPinned, movePinned, pinPanel, unpinPanel } from "../../actions/board-pins.ts";
import { boardRefusal, changeBoard, deleteBoard, duplicateBoard, listAllBoards, makeBoard, showBoard, type BoardError } from "../../actions/boards.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { split, fill, len } from "../ui/layout.ts";
import { emptyState } from "../ui/widgets.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { ListState, Scroll, drawList, promptScreen, drawLines, hitList, hitScroll, metaOf, plural, runAsync, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

/** One line of plain text: a title or a query value may carry escapes the terminal must not obey. */
export const plain = (text: string): string =>
  // eslint-disable-next-line no-control-regex
  text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();

export interface BoardRow extends ListRow {
  readonly slug: string;
  /** The title and range as stored, for the prompts that edit them. */
  readonly rawTitle: string;
  readonly range: string;
}

/** The boards as rows; nothing for anyone the action refuses. */
export async function boardRows(session: Session): Promise<BoardRow[]> {
  const listed = await listAllBoards(session.app, session.user);
  if (!listed.ok) return [];
  return listed.value.map((b) => ({
    slug: b.slug,
    rawTitle: b.board.title,
    range: b.board.range,
    title: plain(b.board.title),
    secondary: b.slug,
    meta: metaOf(plural(b.board.panels.length, "panel"), b.board.range),
  }));
}

/** A step in seconds as the API takes it: `5m`, `1h`, `1d`, or seconds. */
export const stepWords = (s: number): string =>
  s % 86_400 === 0 ? `${s / 86_400}d` : s % 3600 === 0 ? `${s / 3600}h` : s % 60 === 0 ? `${s / 60}m` : `${s}s`;

/** What a panel's data says in one line: its last bucket and step, its row count, or why it was refused. */
export function dataLine(d: PanelData): string {
  if (!d.ok) return `refused: ${plain(d.error)}`;
  if (d.step === null) return plural(d.rows.length, "row");
  const last = d.rows.at(-1);
  const at = `step ${stepWords(d.step)} · ${plural(d.rows.length, "point")}`;
  return last === undefined ? `no points · ${at}` : `last ${plain(String(last.group ?? "all"))}: ${formatValue(last.value ?? 0)} · ${at}`;
}

/**
 * A board, panel by panel, as lines of text; the panel at `at` is marked, a
 * pinned one says so, and each panel with its `data` read says what it holds.
 */
export function boardLines(board: Board, at = -1, pinned: readonly string[] = [], data: readonly PanelData[] = []): string[] {
  const lines = [
    plain(board.title),
    `range ${board.range} · refresh ${board.refresh} · ${plural(board.panels.length, "panel")}`,
  ];
  for (const [i, p] of board.panels.entries()) {
    const query = Object.entries(p.query)
      .map(([k, v]) => `${plain(k)}=${plain(typeof v === "string" ? v : JSON.stringify(v))}`)
      .join(" ");
    lines.push("", `${i === at ? "▸ " : ""}${plain(p.title)}${pinned.includes(p.title) ? "  [pinned to home]" : ""}`, `  ${p.chart} · ${p.w}×${p.h}`, `  ${query === "" ? "no query" : query}`);
    const d = data[i];
    if (d !== undefined) lines.push(`  ${dataLine(d)}`);
  }
  return lines;
}

export function boardScreen(ctx: Ctx, f: Session, slug: string, first: Board): Screen {
  let board = first;
  const scroll = new Scroll();
  let at = board.panels.length > 0 ? 0 : -1;
  let pinned: string[] = [];
  let data: PanelData[] = [];
  /** The panel `x` asked about (where it sat and its title), until `y` or `n`. */
  let asking: { readonly index: number; readonly title: string } | undefined;
  // The gate is `changeBoard`'s, read once as the list's is.
  const mayEdit = f.user?.isAdmin === true && f.user.kind !== "agent";
  let lines = boardLines(board, at, pinned);
  const read = async (): Promise<void> => {
    const listed = await listPinned(f.app, f.user);
    pinned = listed.ok ? listed.value.filter((p) => p.slug === slug).map((p) => p.title) : [];
    // Only an admin person reaches this screen (`showBoard` let them in), as `panelData` asks.
    data = board.panels.map((p) => panelData(f.app.db, board, p));
    lines = boardLines(board, at, pinned, data);
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
  const reload = async (index: number): Promise<void> => {
    const shown = await showBoard(f.app, f.user, slug);
    if (shown.ok) {
      board = shown.value;
      at = Math.min(index, board.panels.length - 1);
    }
    await read();
  };
  /**
   * Remove the panel asked about as the web's Remove does; pins are left as `changeBoard` leaves them.
   * `changeBoard` removes by index, so the board is read again first: when another door moved or removed
   * panels and `index` no longer holds `title`, nothing is removed and the screen shows the board as it is.
   */
  const drop = (index: number, title: string): void =>
    runAsync(ctx, async () => {
      const now = await showBoard(f.app, f.user, slug);
      if (!now.ok) return void ctx.toast(refusal(now.error), "danger");
      if (now.value.panels[index]?.title !== title) {
        await reload(index);
        return void ctx.toast("The board changed; nothing was removed.", "danger");
      }
      const done = await changeBoard(f.app, f.user, slug, { kind: "remove", index });
      await reload(index);
      ctx.toast(done.ok ? "panel removed" : refusal(done.error), done.ok ? "success" : "danger");
    });
  return {
    title: plain(board.title),
    get keys() {
      return [
        binding(["j", "k"], "scroll"), binding(["[", "]"], "panel"), binding(["p"], "pin / unpin"),
        binding(["<", ">"], "move pin"),
        ...(mayEdit && board.panels.length > 0 ? [binding(["x"], "remove panel")] : []),
        binding(["esc", "q"], "back"),
      ];
    },
    load: read,
    render(area, s) {
      const c = ctx.theme.c;
      if (asking !== undefined) {
        s.text(area.x, area.y, truncate(`remove ${plain(asking.title)}? y/n`, area.w), style(c.fg, c.bg), area.x + area.w);
        area = { ...area, y: area.y + 1, h: Math.max(0, area.h - 1) };
      }
      const spans = lines.map((text, i) => [{ text, style: style(i === 0 ? c.fg : c.mutedFg, c.bg) }]);
      drawLines(s, area, c, scroll, spans);
      hitScroll(ctx, area, scroll, lines.length);
    },
    key(e) {
      if (asking !== undefined) {
        const asked = asking;
        if (e.key === "y" || e.key === "n" || e.key === "esc") {
          asking = undefined;
          if (e.key === "y") drop(asked.index, asked.title);
          ctx.invalidate();
        }
        return true;
      }
      if (scroll.key(e, lines.length)) return true;
      if (e.key === "x") {
        const panel = board.panels[at];
        if (mayEdit && panel !== undefined) asking = { index: at, title: panel.title };
        ctx.invalidate();
        return true;
      }
      if (e.key === "[" || e.key === "]") {
        if (board.panels.length > 0) at = (at + (e.key === "]" ? 1 : board.panels.length - 1)) % board.panels.length;
        lines = boardLines(board, at, pinned, data);
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

/** A refusal in the page's words, cleaned for the terminal. */
export const refusal = (e: BoardError): string => plain(boardRefusal(e));

export function boardsScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  let rows: BoardRow[] = [];
  /** The board `D` asked about, until `y` or `n`. */
  let asking: BoardRow | undefined;
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
  const make = (): void => {
    ctx.push(
      promptScreen(ctx, screen, {
        title: "New board",
        label: "Title",
        onSubmit: (title) =>
          ctx.track((async () => {
            const made = await makeBoard(f.app, f.user, title);
            await read();
            if (!made.ok) return void ctx.toast(refusal(made.error), "danger");
            ctx.toast("board made", "success");
            const shown = await showBoard(f.app, f.user, made.value);
            if (shown.ok) ctx.push(boardScreen(ctx, f, made.value, shown.value));
            else ctx.invalidate();
          })()),
      }),
    );
  };
  const copy = (row: BoardRow): void =>
    runAsync(ctx, async () => {
      const done = await duplicateBoard(f.app, f.user, row.slug);
      if (done.ok) await read();
      ctx.toast(done.ok ? `copied as ${done.value}` : refusal(done.error), done.ok ? "success" : "danger");
      ctx.invalidate();
    });
  const remove = (row: BoardRow): void =>
    runAsync(ctx, async () => {
      const done = await deleteBoard(f.app, f.user, row.slug);
      await read();
      ctx.toast(done.ok ? "board deleted" : refusal(done.error), done.ok ? "success" : "danger");
      ctx.invalidate();
    });
  // The gate is `changeBoard`'s, read once as the board screen's is.
  const mayEdit = f.user?.isAdmin === true && f.user.kind !== "agent";
  /** Prompt for a new value of the row's board and apply it as the board page's Rename and Settings do. */
  const edit = (row: BoardRow, what: "title" | "range"): void => {
    ctx.push(
      promptScreen(ctx, screen, {
        title: what === "title" ? "Rename board" : "Board range",
        label: what === "title" ? "Title" : `Range (${RANGES.join(", ")})`,
        value: what === "title" ? row.rawTitle : row.range,
        onSubmit: (value) =>
          ctx.track((async () => {
            // The refresh is the board's now, so a range change keeps it.
            const now = await showBoard(f.app, f.user, row.slug);
            const done = !now.ok
              ? now
              : await changeBoard(f.app, f.user, row.slug, what === "title" ? { kind: "title", title: value } : { kind: "settings", range: value, refresh: now.value.refresh });
            await read();
            ctx.toast(done.ok ? (what === "title" ? "renamed" : "range changed") : refusal(done.error), done.ok ? "success" : "danger");
            ctx.invalidate();
          })()),
      }),
    );
  };
  const screen: Screen = {
    title: "Boards",
    get keys() {
      return [
        binding(["j", "k"], "move"), binding(["enter"], "open"), binding(["n"], "new"), binding(["c"], "copy"),
        ...(mayEdit ? [binding(["e"], "rename"), binding(["g"], "range")] : []),
        binding(["D"], "delete"), binding(["r"], "refresh"),
      ];
    },
    load: read,
    render(area, s) {
      const c = ctx.theme.c;
      const [head, body] = split(area, "v", [len(1), fill(1)]);
      const headline = asking ? `delete ${asking.title}? y/n` : plural(rows.length, "board");
      s.text(head!.x, head!.y, truncate(headline, head!.w), style(asking ? c.fg : c.mutedFg, c.bg), head!.x + head!.w);
      if (rows.length === 0) {
        emptyState(s, body!, c, {
          title: "No boards yet",
          body: "Press n to make one.",
        });
        return;
      }
      drawList(s, body!, c, state, rows);
      hitList(ctx, body!, state, rows.length, { open });
    },
    key(e) {
      if (asking) {
        const row = asking;
        if (e.key === "y" || e.key === "n" || e.key === "esc") {
          asking = undefined;
          if (e.key === "y") remove(row);
          ctx.invalidate();
        }
        return true;
      }
      // Before the list's own keys: `g` would jump to the top.
      if (mayEdit && (e.key === "e" || e.key === "g")) {
        const row = rows[state.index];
        if (row !== undefined) edit(row, e.key === "e" ? "title" : "range");
        return true;
      }
      if (state.key(e, rows.length)) return true;
      if (e.key === "enter") {
        open(state.index);
        return true;
      }
      if (e.key === "n") return make(), true;
      if (e.key === "c" || e.key === "D") {
        const row = rows[state.index];
        if (row === undefined) return true;
        if (e.key === "c") copy(row);
        else asking = row;
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
  return screen;
}

/** The boards, as the page gates them: a site admin who is a person, never an agent (#1817). */
export const entry: PaletteEntry = {
  id: "boards",
  title: "Boards",
  hint: "the forge's boards and their panels",
  after: ["sentinel"],
  offered: (session) => session.user?.isAdmin === true && session.user.kind !== "agent",
  run: (session, ctx) => ctx.push(boardsScreen(session, ctx)),
};
