/**
 * The family across forges (#425) in a card: the same lines as /family, from
 * the same view, so the gate (guests see the parent, admins also the
 * children) is `spawn/family.ts`'s and not this screen's.
 */

import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { card } from "../ui/widgets.ts";
import { drawFacts } from "./common.ts";

export function familyScreen(ctx: Ctx, rows: readonly (readonly [string, string])[], title = "Family"): Screen {
  return {
    title,
    keys: [binding(["esc"], "close")],
    render(area, s) {
      const c = ctx.theme.c;
      const w = Math.min(78, Math.max(30, area.w - 6));
      const h = Math.min(area.h, rows.length + 2);
      const r = { x: area.x + ((area.w - w) >> 1), y: area.y + ((area.h - h) >> 1), w, h };
      const inner = card(s, r, c, { title, focused: true });
      drawFacts(s, { x: inner.x + 1, y: inner.y, w: Math.max(0, inner.w - 1), h: inner.h }, c, rows, c.card);
    },
    key(e) {
      if (e.key === "esc" || e.key === "q") ctx.pop();
      return true;
    },
  };
}
