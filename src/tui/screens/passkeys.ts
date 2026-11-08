/**
 * Your passkeys in the terminal (#8044): the list, and `d` to remove the one
 * under the cursor after a y/n (#8045). A passkey is made by a browser
 * ceremony, so this screen never offers to add one; it names where to,
 * Settings › Passkeys. Removing goes through `removeOwnPasskey`, the rule
 * Settings and MCP `whoami_can` share, and says their words. The list is your
 * own passkeys, never another account's, as MCP `whoami_can kind: passkeys`
 * shows them.
 */

import { LAST_WAY_IN, removeOwnPasskey } from "../../actions/passkeys.ts";
import { listPasskeys } from "../../core/passkeys.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, confirmScreen, drawList, type ListRow } from "./common.ts";

export function passkeysScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  let note = "";
  const items = () => (f.user === undefined ? [] : listPasskeys(f.app.db, f.user.id));

  const rows = (): ListRow[] =>
    items().map((p) => ({
      title: p.name,
      meta: `added ${p.createdAt.slice(0, 10)}, used ${p.lastUsedAt?.slice(0, 10) ?? "never"}`,
    }));

  const screen: Screen = {
    title: "Passkeys",
    keys: [binding(["j", "k"], "move cursor"), binding(["d"], "remove")],
    render(area, s) {
      const c = ctx.theme.c;
      const [head, body] = split(area, "v", [len(1), fill(1)]);
      const text =
        note !== ""
          ? note
          : items().length === 0
            ? "None yet. Add one on the web: Settings › Passkeys."
            : "Passkeys that sign in as you. d removes one; add one on the web, Settings › Passkeys.";
      s.text(head!.x, head!.y, truncate(text, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, body!, c, state, rows());
    },
    key(e) {
      if (state.key(e, items().length)) return true;
      if (e.ctrl || e.alt) return false;
      if (e.key === "d") {
        const p = items()[state.index];
        if (p === undefined || f.user === undefined) return false;
        const user = f.user;
        ctx.push(
          confirmScreen(ctx, screen, {
            title: "Remove passkey",
            body: [`remove passkey ${p.name}? y/n`],
            actions: [{ label: "Remove", variant: "danger" }, { label: "Cancel", variant: "ghost" }],
            selected: 1,
            yesNo: true,
            onChoose: (i) => {
              if (i !== 0) return;
              const gone = removeOwnPasskey(f.app, user, p.id);
              note = gone.ok ? "Passkey removed." : gone.error === "last_way_in" ? LAST_WAY_IN : "No such passkey.";
              ctx.invalidate();
            },
          }),
        );
        return true;
      }
      return false;
    },
  };
  return screen;
}
