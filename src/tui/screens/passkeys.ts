/**
 * Your passkeys in the terminal (#8044): the list, read only. A passkey is
 * made by a browser ceremony, so this screen never offers to add one; it
 * names where to, Settings › Passkeys. The list is your own passkeys, never
 * another account's, as MCP `whoami_can kind: passkeys` shows them.
 */

import { listPasskeys } from "../../core/passkeys.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, drawList, type ListRow } from "./common.ts";

export function passkeysScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  const items = () => (f.user === undefined ? [] : listPasskeys(f.app.db, f.user.id));

  const rows = (): ListRow[] =>
    items().map((p) => ({
      title: p.name,
      meta: `added ${p.createdAt.slice(0, 10)}, used ${p.lastUsedAt?.slice(0, 10) ?? "never"}`,
    }));

  return {
    title: "Passkeys",
    keys: [binding(["j", "k"], "move cursor")],
    render(area, s) {
      const c = ctx.theme.c;
      const [head, body] = split(area, "v", [len(1), fill(1)]);
      const text =
        items().length === 0
          ? "None yet. Add one on the web: Settings › Passkeys."
          : "Passkeys that sign in as you. Read only: add or remove one on the web, Settings › Passkeys.";
      s.text(head!.x, head!.y, truncate(text, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, body!, c, state, rows());
    },
    key(e) {
      return state.key(e, items().length);
    },
  };
}
