/**
 * Buy links in the terminal, a forge admin's (#11149): one row a size with its
 * link, as Buy links on /admin/limits shows them. Enter on a row asks for an
 * https address (empty clears it) and saves it after the same checks as the
 * page. Reading and changing go through `readBillingLinks`/`changeBillingLinks`,
 * so the gate is theirs: an admin who is a person; anyone else sees nothing.
 */

import { changeBillingLinks, readBillingLinks } from "../../actions/signup.ts";
import { BILLING_SIZES } from "../../settings/billing.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, drawList, promptScreen, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

export function billingLinksScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  let note = "";
  const read = () => readBillingLinks(f.app, f.user);

  const save = (size: (typeof BILLING_SIZES)[number], raw: string): string | undefined => {
    const now = read();
    if (!now.ok) return "You cannot change buy links.";
    const next: Record<string, string> = { ...now.value, [size]: raw.trim() };
    const changed = changeBillingLinks(f.app, f.user, next);
    if (!changed.ok) return changed.error === "not_found" ? "You cannot change buy links." : "A buy link is an https address, or empty.";
    note = `${size}: ${changed.value[size] ?? "no link"}.`;
    ctx.invalidate();
    return undefined;
  };

  const rows = (): ListRow[] => {
    const r = read();
    return BILLING_SIZES.map((z) => ({ title: z, secondary: r.ok ? (r.value[z] ?? "no link") : "" }));
  };

  const screen: Screen = {
    title: "Buy links",
    keys: [binding(["j", "k"], "move cursor"), binding(["enter"], "set the link")],
    render(area, s) {
      const c = ctx.theme.c;
      const [head, body] = split(area, "v", [len(1), fill(1)]);
      const text = note !== "" ? note : read().ok ? "With any link set, the home page offers paid forges. Enter sets one." : "Buy links are set by a forge admin.";
      s.text(head!.x, head!.y, truncate(text, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, body!, c, state, rows());
    },
    key(e) {
      note = "";
      if (state.key(e, BILLING_SIZES.length)) return true;
      if (e.ctrl || e.alt || !read().ok || e.key !== "enter") return false;
      const size = BILLING_SIZES[state.index];
      if (size === undefined) return false;
      const now = read();
      ctx.push(
        promptScreen(ctx, screen, {
          title: `Buy link: ${size}`,
          label: "https address, empty for none",
          value: now.ok ? (now.value[size] ?? "") : "",
          onSubmit: (v) => save(size, v),
        }),
      );
      return true;
    },
  };
  return screen;
}

/** Buy links, as /admin/limits has them: an admin who is a person. */
export const entry: PaletteEntry = {
  id: "billing-links",
  title: "Buy links",
  hint: "where each hosted plan is paid for, shown on the home page",
  after: ["limits", "invites"],
  offered: (session) => session.user?.isAdmin === true && session.user.kind === "user",
  run: (session, ctx) => ctx.push(billingLinksScreen(session, ctx)),
};
