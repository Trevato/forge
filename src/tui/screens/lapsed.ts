/**
 * Forges whose billing is `none` (#11393) in the terminal, a forge admin's who
 * is a person: why each sleeps, until when its data is kept, the export line,
 * and `p` to start the checkout to pay again, whose address is shown to hand
 * to the payer. The same sentences as the wake page (`billing/lapse_words.ts`)
 * and the same checkout (`billing/pay_again.ts`).
 */

import { readBilling } from "../../actions/billing.ts";
import { lapseFor } from "../../billing/lapse.ts";
import { exportSentence, lapsedSentence } from "../../billing/lapse_words.ts";
import { canPayAgain, startPayAgain } from "../../billing/pay_again.ts";
import { publicOrigin } from "../../core/public_origin.ts";
import { childUrlOf } from "../../spawn/door.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate, wrap } from "../term/width.ts";
import type { Session } from "../session.ts";
import { emptyState } from "../ui/widgets.ts";
import { ListState } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

const isAdmin = (f: Session): boolean => f.user?.isAdmin === true && f.user.kind !== "agent";

/** The forges asleep for want of payment, with the lines that say why and how to export. */
export function lapsedForges(f: Session): { name: string; lines: string[] }[] {
  const read = readBilling(f.app, f.user);
  if (!read.ok) return [];
  const front = publicOrigin(f.app.config.url, `http://${f.app.config.host ?? "localhost"}`);
  const out: { name: string; lines: string[] }[] = [];
  for (const e of read.value.forges) {
    const lapse = lapseFor(f.app.db, e.forge);
    if (lapse.state !== "none") continue;
    out.push({ name: e.forge, lines: [lapsedSentence(e.forge), exportSentence(lapse, front)] });
  }
  return out;
}

export function lapsedScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  let note = "";
  return {
    title: "Lapsed forges",
    keys: [binding(["j", "k"], "move cursor"), binding(["p"], "start checkout to pay again"), binding(["esc"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      const rows = lapsedForges(f);
      state.clamp(rows.length);
      if (rows.length === 0) {
        emptyState(s, area, c, { title: "No forge is asleep for want of payment.", body: note });
        return;
      }
      let y = area.y;
      rows.forEach((r, i) => {
        s.text(area.x + 1, y++, truncate(`${i === state.index ? "> " : "  "}${r.name}`, area.w - 2), style(c.fg, c.bg), area.x + area.w);
        for (const l of r.lines) for (const w of wrap(l, area.w - 6)) if (y < area.y + area.h - 1) s.text(area.x + 4, y++, w, style(c.mutedFg, c.bg), area.x + area.w);
      });
      if (note !== "") s.text(area.x + 1, area.y + area.h - 1, truncate(note, area.w - 2), style(c.mutedFg, c.bg), area.x + area.w);
    },
    key(e) {
      const rows = lapsedForges(f);
      const target = rows[state.index];
      if (e.key === "p" && target !== undefined) {
        if (!canPayAgain(f.app, target.name)) note = "Paying is not set up on this forge yet.";
        else {
          note = "Making the checkout…";
          void startPayAgain(f.app, target.name, childUrlOf(f.app, target.name).replace(/\/+$/, "")).then((made) => {
            note = made.ok ? `Pay here: ${made.value}` : `${made.error}.`;
            ctx.invalidate();
          });
        }
        ctx.invalidate();
        return true;
      }
      return state.key(e, rows.length);
    },
  };
}

/** Forges asleep for want of payment, and the checkout to pay again. */
export const entry: PaletteEntry = {
  id: "lapsed",
  title: "Lapsed forges",
  hint: "forges asleep until paid, when their data goes, pay again",
  after: ["billing"],
  offered: isAdmin,
  run: (session, ctx) => ctx.push(lapsedScreen(session, ctx)),
};
