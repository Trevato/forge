/**
 * The Plan row in the terminal (#11141): the plan line a forge's admins see
 * at the top of /settings (`planLine`, the page's own words) and, for an
 * admin who is a person, the billing portal address with Enter to set it,
 * through `changePortalUrl` so the gate and the checks are the page's.
 */

import { changePortalUrl } from "../../actions/signup.ts";
import { getPortalUrl } from "../../settings/billing.ts";
import { planLine } from "../../web/plan_row.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, drawList, promptScreen } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

const person = (f: Session): boolean => f.user?.isAdmin === true && f.user.kind === "user";

export function planRowScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  let note = "";
  const screen: Screen = {
    title: "Plan",
    keys: [binding(["enter"], "set the billing portal address")],
    render(area, s) {
      const c = ctx.theme.c;
      const [head, body] = split(area, "v", [len(1), fill(1)]);
      const text = note !== "" ? note : (planLine(f.app.config.dataDir) ?? "This forge was told no plan.");
      s.text(head!.x, head!.y, truncate(text, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, body!, c, state, [{ title: "Billing portal", secondary: getPortalUrl(f.app.db) || "no link" }]);
    },
    key(e) {
      note = "";
      if (e.ctrl || e.alt || e.key !== "enter" || !person(f)) return false;
      ctx.push(
        promptScreen(ctx, screen, {
          title: "Billing portal",
          label: "https address, empty for none",
          value: getPortalUrl(f.app.db),
          onSubmit: (v) => {
            const set = changePortalUrl(f.app, f.user, v.trim());
            if (!set.ok) return set.error === "not_found" ? "You cannot change the billing portal." : "The billing portal is one https address, or empty.";
            note = `Billing portal: ${set.value || "no link"}.`;
            ctx.invalidate();
            return undefined;
          },
        }),
      );
      return true;
    },
  };
  return screen;
}

/** The plan line and the portal address: an admin of the forge. */
export const entry: PaletteEntry = {
  id: "plan-row",
  title: "Plan",
  hint: "this forge's plan, and where its owner manages billing",
  after: ["billing-links", "limits"],
  offered: (session) => session.user?.isAdmin === true,
  run: (session, ctx) => ctx.push(planRowScreen(session, ctx)),
};
