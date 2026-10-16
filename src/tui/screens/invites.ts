/**
 * Invite links in the terminal, a forge admin's (#2337): every link with its
 * state, when it was made and when it expires, as Invite links on /admin/limits
 * shows them. `m` mints one from a number of days (1 to 30, 7 by default) and
 * prints the link once, on this screen, until the next key of any kind; `x` revokes the
 * selected open one. Both go through the actions, so the gate is theirs: an
 * admin who is a person; anyone else sees nothing and mints nothing.
 */

import { inviteLink, list, mint, revoke } from "../../actions/invites.ts";
import { DEFAULT_DAYS, MAX_DAYS } from "../../core/invites.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, drawList, promptScreen, type ListRow } from "./common.ts";

export function invitesScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  let note = "";
  const read = () => list(f.app, f.user);
  const items = () => {
    const r = read();
    return r.ok ? r.value : [];
  };

  const make = (raw: string): string | undefined => {
    const text = raw.trim();
    const days = text === "" ? DEFAULT_DAYS : /^\d{1,3}$/.test(text) ? Number(text) : -1;
    const made = mint(f.app, f.user, days);
    if (!made.ok)
      return made.error === "invalid_days"
        ? `Days is a whole number from 1 to ${MAX_DAYS}.`
        : "You cannot make invite links.";
    const origin = f.app.config.url ?? `http://localhost:${f.app.config.port}`;
    note = `Shown once: ${inviteLink(origin, made.value.token)}`;
    ctx.invalidate();
    return undefined;
  };

  const rows = (): ListRow[] =>
    items().map((i) => ({
      title: i.id,
      secondary: i.state,
      meta: `made ${i.createdAt.slice(0, 16)}  expires ${i.expiresAt.slice(0, 16)}`,
    }));

  const screen: Screen = {
    title: "Invite links",
    keys: [binding(["j", "k"], "move cursor"), binding(["m"], "make a link"), binding(["x"], "revoke")],
    render(area, s) {
      const c = ctx.theme.c;
      const r = read();
      const [head, body] = split(area, "v", [len(1), fill(1)]);
      const text =
        note !== ""
          ? note
          : !r.ok
            ? "Invite links are made by a forge admin."
            : r.value.length === 0
              ? "No invite link yet. m makes one."
              : "Each link is good for one signup. m makes one, x revokes.";
      s.text(head!.x, head!.y, truncate(text, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, body!, c, state, rows());
    },
    key(e) {
      note = "";
      const all = items();
      if (state.key(e, all.length)) return true;
      if (e.ctrl || e.alt || !read().ok) return false;
      if (e.key === "m") {
        ctx.push(
          promptScreen(ctx, screen, {
            title: "Invite link",
            label: `days until it expires, 1 to ${MAX_DAYS}`,
            value: String(DEFAULT_DAYS),
            onSubmit: make,
          }),
        );
      } else if (e.key === "x") {
        const row = all[state.index];
        if (row === undefined) return false;
        note = revoke(f.app, f.user, row.id).ok ? `Revoked ${row.id}.` : "That link is not open.";
        ctx.invalidate();
      } else return false;
      return true;
    },
  };
  return screen;
}
