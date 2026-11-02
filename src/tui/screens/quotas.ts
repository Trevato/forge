/**
 * Account quotas in the terminal, a forge admin's (#2191): every quota key
 * (`QUOTA_KEYS`) with its limit and the recent changes, as Account quotas on
 * /admin/limits shows them. Enter sets one from a positive whole number (empty
 * for no limit); `x` clears it. Both go through `changeQuotas`, so `parseQuota`
 * checks the value and the change is kept, as on the page. The gate is the
 * action's: an admin who is not an agent; anyone else sees nothing and sets nothing.
 */

import { QUOTA_INVALID } from "../../actions/admin_limits_words.ts";
import { changeQuotas, readQuotas } from "../../actions/quotas.ts";
import { QUOTA_KEYS, type QuotaChange } from "../../settings/quotas.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, drawList, promptScreen, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

const limit = (v: number | string | null): string => (v === null || v === "" ? "no limit" : String(v));

const changeLine = (c: QuotaChange): string =>
  `${c.at.slice(0, 16)}  ${c.key} ${limit(c.from)} → ${limit(c.to)}  ${c.actorName}`;

export function quotasScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  let note = "";
  const read = () => readQuotas(f.app, f.user);
  const allowed = (): boolean => read().ok;

  const save = (key: string, raw: string | null): string | undefined => {
    const made = changeQuotas(f.app, f.user, { [key]: raw });
    if (made.ok) {
      note = `${key}: ${limit(made.value[key as (typeof QUOTA_KEYS)[number]])}.`;
      ctx.invalidate();
      return undefined;
    }
    return made.error === "invalid_quota"
      ? QUOTA_INVALID
      : "You cannot change quotas.";
  };

  const rows = (): ListRow[] => {
    const r = read();
    if (!r.ok) return [];
    const recent = (key: string) => r.value.changes.find((c) => c.key === key);
    return QUOTA_KEYS.map((key) => {
      const last = recent(key);
      return {
        title: key,
        secondary: limit(r.value.quotas[key]),
        meta: last === undefined ? "never changed" : changeLine(last),
      };
    });
  };

  const screen: Screen = {
    title: "Account quotas",
    keys: [binding(["j", "k"], "move cursor"), binding(["enter"], "set"), binding(["x"], "clear")],
    render(area, s) {
      const c = ctx.theme.c;
      const r = read();
      const [head, list] = split(area, "v", [len(1), fill(1)]);
      const text =
        note !== ""
          ? note
          : !r.ok
            ? "Quotas are set by a forge admin."
            : r.value.changes[0] === undefined
              ? "What one account may own. No change yet."
              : changeLine(r.value.changes[0]);
      s.text(head!.x, head!.y, truncate(text, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, list!, c, state, rows());
    },
    key(e) {
      if (state.key(e, allowed() ? QUOTA_KEYS.length : 0)) return true;
      if (e.ctrl || e.alt || !allowed()) return false;
      const key = QUOTA_KEYS[state.index];
      if (key === undefined) return false;
      if (e.key === "x") save(key, null);
      else if (e.key === "enter") {
        const now = read();
        ctx.push(
          promptScreen(ctx, screen, {
            title: key,
            label: "a positive whole number, empty for no limit",
            value: now.ok ? (now.value.quotas[key]?.toString() ?? "") : "",
            onSubmit: (raw) => save(key, raw),
          }),
        );
      } else return false;
      return true;
    },
  };
  return screen;
}

/** Account quotas, as /admin/limits has them: an admin who is not an agent (#2191). */
export const entry: PaletteEntry = {
  id: "quotas",
  title: "Account quotas",
  hint: "what one account may own, and who changed it",
  after: ["people", "can"],
  offered: (session) => session.user?.isAdmin === true && session.user.kind !== "agent",
  run: (session, ctx) => ctx.push(quotasScreen(session, ctx)),
};
