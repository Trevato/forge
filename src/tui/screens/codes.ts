/**
 * Gift codes in the terminal, a forge admin's who is a person: the same
 * `readCodes`, `makeCode` and `revoke` the page, the API and MCP use. `n`
 * makes a code on the plan `p` has chosen and shows the plain code and its
 * link once (it is kept only as a hash); `x` revokes the one under the cursor
 * after a yes/no. Live: a code made or redeemed anywhere refreshes the list.
 */

import { makeCode, readCodes, revoke, CODE_ERRORS } from "../../actions/codes.ts";
import { publicOrigin } from "../../core/public_origin.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { fill, len, split } from "../ui/layout.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { ListState, confirmScreen, drawList, live, yesNo, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

const isAdmin = (f: Session): boolean => f.user?.isAdmin === true && f.user.kind !== "agent";

export function codeRows(f: Session): { rows: ListRow[]; ids: string[]; plans: string[] } {
  const read = readCodes(f.app, f.user);
  if (!read.ok) return { rows: [], ids: [], plans: [] };
  const rows = read.value.codes.map((c) => {
    const state = c.revokedAt !== undefined ? "revoked" : c.used >= c.uses ? "used up" : "";
    const who = c.redeemed.map((r) => r.forge).join(", ");
    return { title: `${c.plan}${c.note === "" ? "" : ` · ${c.note}`}`, secondary: `${c.used} of ${c.uses} used${state === "" ? "" : ` · ${state}`}`, meta: who };
  });
  return { rows, ids: read.value.codes.map((c) => c.id), plans: read.value.plans };
}

export function codesScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  let plan = 0;
  let note = "";
  const screen: Screen = {
    title: "Gift codes",
    keys: [binding(["j", "k"], "move cursor"), binding(["p"], "choose plan"), binding(["n"], "make a code"), binding(["x"], "revoke"), binding(["esc"], "back")],
    async load(signal) {
      live(f, signal, { where: (e) => e.kind.startsWith("billing.code.") }, () => ctx.invalidate());
    },
    render(area, s) {
      const c = ctx.theme.c;
      const { rows, plans } = codeRows(f);
      state.clamp(rows.length);
      const [head, body] = split(area, "v", [len(2), fill(1)]);
      const chosen = plans[plan % Math.max(plans.length, 1)] ?? "";
      s.text(head!.x, head!.y, truncate(note !== "" ? note : `Plan ${chosen}: n makes a code, p changes the plan`, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      if (rows.length === 0) s.text(body!.x, body!.y, truncate("No code yet.", body!.w), style(c.mutedFg, c.bg), body!.x + body!.w);
      else drawList(s, body!, c, state, rows);
    },
    key(e) {
      const { rows, ids, plans } = codeRows(f);
      if (e.key === "p" && plans.length > 0) {
        plan = (plan + 1) % plans.length;
        ctx.invalidate();
        return true;
      }
      if (e.key === "n") {
        const chosen = plans[plan % Math.max(plans.length, 1)];
        const made = makeCode(f.app, f.user, { plan: chosen ?? "" }, publicOrigin(f.app.config.url, `http://localhost:${f.app.config.port}`));
        note = made.ok ? `Shown once: ${made.value.code}  ${made.value.link}` : made.error === "not_found" ? "Not found." : `${CODE_ERRORS[made.error]}.`;
        ctx.invalidate();
        return true;
      }
      const id = ids[state.index];
      if (e.key === "x" && id !== undefined) {
        const go = (i: number): void => {
          if (i !== 0) return;
          const done = revoke(f.app, f.user, id);
          note = done.ok ? "Code revoked. Forges already made keep their plan." : "Not found.";
          ctx.invalidate();
        };
        const ask = confirmScreen(ctx, screen, {
          title: "Revoke a code",
          body: [`Stop ${rows[state.index]!.title} working? Made forges keep their plan.`],
          actions: [{ label: "Revoke" }, { label: "Cancel" }],
          onChoose: go,
        });
        ctx.push(yesNo(ctx, ask, go));
        return true;
      }
      return state.key(e, rows.length);
    },
  };
  return screen;
}

/** Make, list and revoke gift codes. */
export const entry: PaletteEntry = {
  id: "codes",
  title: "Gift codes",
  hint: "make a code that gives a plan for free, and revoke one",
  offered: isAdmin,
  run: (session, ctx) => ctx.push(codesScreen(session, ctx)),
};
