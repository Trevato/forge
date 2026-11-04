/**
 * Edge-only accounts in the terminal, a forge admin's: the people the card at
 * the top of Settings → Accounts names, from the same `edgeOnlyAccounts`.
 * Each can sign in only through the platform edge, so switching
 * `signin.edge` off would lock them out until they add a passkey.
 */

import { edgeOnlyAccounts } from "../../core/accounts.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { fill, len, split } from "../ui/layout.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { emptyState } from "../ui/widgets.ts";
import { ListState, drawList, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

const isAdmin = (f: Session): boolean => f.user?.isAdmin === true && f.user.kind !== "agent";

export function edgeOnlyScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  const accounts = isAdmin(f) ? edgeOnlyAccounts(f.db) : [];
  return {
    title: "Edge-only accounts",
    keys: [binding(["j", "k"], "move cursor")],
    render(area, s) {
      const c = ctx.theme.c;
      const [head, body] = split(area, "v", [len(1), fill(1)]);
      if (accounts.length === 0) {
        emptyState(s, body!, c, { title: "No one is edge-only.", body: "Everyone has a password, a passkey or a parent link." });
        return;
      }
      const line = "sign in only through the edge; ask each to add a passkey";
      s.text(head!.x, head!.y, truncate(line, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      const rows: ListRow[] = accounts.map((a) => ({
        title: a.username,
        secondary: a.createdAt.slice(0, 10),
        meta: a.isAdmin ? "admin" : "",
      }));
      drawList(s, body!, c, state, rows);
    },
    key(e) {
      return state.key(e, accounts.length);
    },
  };
}

/** Who would be locked out if the platform edge sign-in went off. */
export const entry: PaletteEntry = {
  id: "edge-only-accounts",
  title: "Edge-only accounts",
  hint: "who would be locked out if the platform edge sign-in went off",
  offered: isAdmin,
  run: (session, ctx) => ctx.push(edgeOnlyScreen(session, ctx)),
};
