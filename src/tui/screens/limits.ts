/**
 * The forge's limits in the terminal, a forge admin's: every limit with its
 * value, default and bounds, as MCP `limits` and /admin/limits list them.
 * `e` asks for a value (empty restores the default), shows the plan, and
 * changes it only after a confirm, through `changeLimit`. A value out of bounds
 * is refused with the words MCP uses (`limitBounds`). The gate is the action's:
 * an admin who is not an agent; anyone else sees nothing and changes nothing.
 */

import { changeLimit, listLimits, type LimitRow } from "../../actions/limits.ts";
import { limitBounds, validLimit } from "../../settings/limits.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, confirmScreen, drawList, promptScreen, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

export function limitsScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  let note = "";
  const read = () => listLimits(f.app, f.user);
  const current = (): LimitRow[] => {
    const r = read();
    return r.ok ? r.value.limits : [];
  };

  const apply = (row: LimitRow, raw: string): void => {
    const made = changeLimit(f.app, f.user, row.key, raw === "" ? null : raw);
    note = made.ok
      ? `${row.key}: ${made.value.from} → ${made.value.to}, from the next use on.`
      : made.error.kind === "out_of_bounds"
        ? made.error.message
        : "You cannot change limits.";
    ctx.invalidate();
  };

  const ask = (row: LimitRow): void => {
    ctx.push(
      promptScreen(ctx, screen, {
        title: row.key,
        label: `a whole number, empty for the default ${row.defaultValue}`,
        value: row.isSet ? String(row.value) : "",
        hint: limitBounds(row.key),
        onSubmit: (raw) => {
          if (raw !== "" && !(/^\d{1,12}$/.test(raw) && validLimit(row.key, Number(raw))))
            return limitBounds(row.key);
          const to = raw === "" ? row.defaultValue : Number(raw);
          return Promise.resolve().then(() => {
            ctx.push(
              confirmScreen(ctx, screen, {
                title: "Change this limit",
                body: [`${row.key}: ${row.value} → ${to}${raw === "" ? " (the default)" : ""}`],
                actions: [{ label: "Keep", variant: "ghost" }, { label: "Change" }],
                onChoose: (i) => {
                  if (i === 1) apply(row, raw);
                },
              }),
            );
          });
        },
      }),
    );
  };

  const rows = (limits: readonly LimitRow[]): ListRow[] =>
    limits.map((l) => ({
      title: l.key,
      secondary: `${l.value} ${l.unit}${l.isSet ? "" : " (default)"}`,
      meta: `default ${l.defaultValue} · ${l.min}–${l.max}`,
    }));

  const screen: Screen = {
    title: "Limits",
    keys: [binding(["j", "k"], "move cursor"), binding(["e"], "change")],
    render(area, s) {
      const c = ctx.theme.c;
      const [head, list] = split(area, "v", [len(1), fill(1)]);
      const r = read();
      const text =
        note !== ""
          ? note
          : r.ok
            ? "What the forge's owner can hit. e changes one."
            : "Limits are set by a forge admin.";
      s.text(head!.x, head!.y, truncate(text, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, list!, c, state, rows(r.ok ? r.value.limits : []));
    },
    key(e) {
      const all = current();
      if (state.key(e, all.length)) return true;
      if (e.ctrl || e.alt || e.key !== "e") return false;
      const row = all[state.index];
      if (row === undefined) return false;
      ask(row);
      return true;
    },
  };
  return screen;
}

/** The forge's limits, as MCP `limits` has them: an admin who is not an agent (#7268). */
export const entry: PaletteEntry = {
  id: "limits",
  title: "Limits",
  hint: "what the forge caps, with default and bounds; change one",
  after: ["quotas", "people", "can"],
  offered: (session) => session.user?.isAdmin === true && session.user.kind !== "agent",
  run: (session, ctx) => ctx.push(limitsScreen(session, ctx)),
};
