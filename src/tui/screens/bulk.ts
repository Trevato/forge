/**
 * Your bulk actions in the terminal (#7937): the operations you took, newest
 * first, as `listFleetOps` has them — action, rows changed, rows refused,
 * when. `u` undoes the selected one while it is inside its day, through
 * `undoFleetOp` (`undoAsksBulk` for one on asks); an undone, expired or
 * undo receipt says why and changes nothing. `enter` opens its rows: each
 * one's before → after and each refusal's reason. The screen is a person's:
 * an agent may preview a mass change, never apply or undo one.
 */

import { getFleetOp, listFleetOps, undoFleetOp, UNDO_WINDOW_MS, isAsksOperation } from "../../actions/fleet.ts";
import { undoable, undoAsksBulk } from "../../actions/asks_bulk.ts";
import type { Operation } from "../../core/fleet_ops.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import { emptyState } from "../ui/widgets.ts";
import { ListState, ago, drawList, plural, runAsync, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

const LIMIT = 30;

const clean = (s: string): string => s.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, "").trim();
const show = (v: unknown): string => clean(v === null || v === undefined ? "—" : Array.isArray(v) ? v.join(", ") : String(v));

/** Why `u` does nothing on a receipt, in words; empty when it undoes. */
export function whyNot(op: Operation, now = Date.now()): string {
  if (undoable(op, now)) return "";
  if (op.undoOf !== null) return "this is an undo, and is not undone again";
  if (op.undoneBy !== null) return "this operation was undone already";
  if (!op.reversible) return `${clean(op.verb)} cannot be undone`;
  if (now - Date.parse(op.createdAt) > UNDO_WINDOW_MS)
    return "an undo is kept for a day, and this one's day is over";
  return "this operation cannot be undone";
}

/** Whether a session is a person's: a bulk action is theirs to take and undo, never an agent's. */
export const isPerson = (session: Session): boolean =>
  session.user !== undefined && session.user.kind === "user";

/** How long the list and its counts are kept before they are read again. */
const KEEP_MS = 2000;

function stateOf(op: Operation): string {
  if (op.undoOf !== null) return "undo";
  if (op.undoneBy !== null) return "undone";
  return undoable(op) ? "u undoes" : "final";
}

/** One operation's rows: label · before → after, or the reason a row was refused. */
function rowsScreen(f: Session, ctx: Ctx, op: Operation): Screen {
  const state = new ListState();
  const full = getFleetOp(f.app, f.user, op.id);
  const rows = full.ok ? full.value.rows : [];
  return {
    title: "Bulk action rows",
    keys: [binding(["j", "k"], "move"), binding(["esc", "q"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      const [head, body] = split(area, "v", [len(1), fill(1)]);
      s.text(head!.x, head!.y, truncate(`${clean(op.verb)} · ${clean(op.query)}`, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      if (rows.length === 0) {
        emptyState(s, body!, c, { title: "No rows kept." });
        return;
      }
      const list: ListRow[] = rows.map((r) => ({
        title: clean(r.label),
        secondary: r.outcome === "ok" ? `${show(r.before)} → ${show(r.after)}` : `${r.outcome}: ${clean(r.reason)}`,
        tone: r.outcome === "ok" ? "success" : "danger",
      }));
      drawList(s, body!, c, state, list);
    },
    key(e) {
      if (e.ctrl || e.alt) return false;
      if (e.key === "esc" || e.key === "q") {
        ctx.pop();
        return true;
      }
      return state.key(e, rows.length);
    },
  };
}

export function bulkScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  const person = (): boolean => isPerson(f);
  // The list and its counts are read once and kept, not on every frame and key.
  let cache: { at: number; items: { op: Operation; done: number; refused: number }[] } | undefined;
  const items = (): { op: Operation; done: number; refused: number }[] => {
    if (!person()) return [];
    if (cache !== undefined && Date.now() - cache.at < KEEP_MS) return cache.items;
    const r = listFleetOps(f.app, f.user, LIMIT);
    const read = (r.ok ? r.value : []).map((op) => {
      const full = getFleetOp(f.app, f.user, op.id);
      const rows = full.ok ? full.value.rows : [];
      const done = rows.filter((x) => x.outcome === "ok").length;
      return { op, done, refused: rows.length - done };
    });
    cache = { at: Date.now(), items: read };
    return read;
  };

  const undo = (op: Operation): void => {
    const why = whyNot(op);
    if (why !== "") {
      ctx.toast(why, "attn");
      return;
    }
    runAsync(ctx, async () => {
      const done = isAsksOperation(op)
        ? await undoAsksBulk(f.app, f.user, op.id)
        : await undoFleetOp(f.app, f.user, op.id);
      cache = undefined;
      ctx.toast(done.ok ? "undone" : done.error.message, done.ok ? "success" : "danger");
      ctx.invalidate();
    });
  };

  const screen: Screen = {
    title: "Bulk actions",
    keys: [
      binding(["j", "k"], "move"),
      binding(["u"], "undo the selected one, inside its day"),
      binding(["enter"], "its rows"),
    ],
    render(area, s) {
      const c = ctx.theme.c;
      const [head, body] = split(area, "v", [len(1), fill(1)]);
      s.text(head!.x, head!.y, truncate("your bulk actions, newest first", head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      const all = items();
      if (all.length === 0) {
        emptyState(s, body!, c, {
          title: person() ? "No bulk actions yet" : "Not available",
          body: person() ? "Archive or dismiss several at once and it is listed here." : "A bulk action is a person's call.",
        });
        return;
      }
      const rows: ListRow[] = all.map(({ op, done, refused }) => ({
        title: `${clean(op.verb)} · ${clean(op.query)}`,
        secondary: `${plural(done, "row")} changed, ${refused} refused`,
        meta: `${stateOf(op)} · ${ago(op.createdAt)}`,
      }));
      drawList(s, body!, c, state, rows);
    },
    key(e) {
      const all = items();
      if (state.key(e, all.length)) return true;
      if (e.ctrl || e.alt || !person()) return false;
      const op = all[state.index]?.op;
      if (op === undefined) return false;
      if (e.key === "u") undo(op);
      else if (e.key === "enter") ctx.push(rowsScreen(f, ctx, op));
      else return false;
      return true;
    },
  };
  return screen;
}

/** Your bulk actions: a person's, never an agent's. */
export const entry: PaletteEntry = {
  id: "bulk",
  title: "Bulk actions",
  hint: "your last bulk actions; u undoes one inside its day",
  after: ["invites", "teams", "limits"],
  offered: isPerson,
  run: (session, ctx) => ctx.push(bulkScreen(session, ctx)),
};
