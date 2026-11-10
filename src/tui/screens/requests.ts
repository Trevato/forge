/**
 * The Waiting list in the terminal, a forge admin's (#10928): strangers who
 * asked for an account, oldest first, as the Waiting card on /settings/accounts
 * has them. `a` allows the selected one and `d` declines it, both through
 * `actions/requests.ts`, so the gate is theirs (an admin who is a person;
 * anyone else sees nothing) and the write reaches web viewers on the bus.
 */

import { allowRequest, declineRequest, listRequests } from "../../actions/requests.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, drawList, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

export function requestsScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  let note = "";
  const read = () => listRequests(f.app, f.user);
  const items = () => {
    const r = read();
    return r.ok ? r.value : [];
  };

  const rows = (): ListRow[] =>
    items().map((r) => ({
      title: r.username,
      secondary: r.note === "" ? "no note" : r.note,
      meta: `asked ${r.askedAt.slice(0, 16)}  from ${r.source === "" ? "the web" : r.source}`,
    }));

  const answer = (act: "allow" | "decline"): boolean => {
    const row = items()[state.index];
    if (row === undefined) return false;
    const done = (act === "allow" ? allowRequest : declineRequest)(f.app, f.user, row.username);
    note = done.ok
      ? `${row.username} ${act === "allow" ? "is in" : "was declined, politely"}.`
      : `${row.username} is not waiting any more.`;
    ctx.invalidate();
    return true;
  };

  const screen: Screen = {
    title: "Waiting",
    keys: [binding(["j", "k"], "move cursor"), binding(["a"], "allow"), binding(["d"], "decline")],
    render(area, s) {
      const c = ctx.theme.c;
      const r = read();
      const [head, body] = split(area, "v", [len(1), fill(1)]);
      const text =
        note !== ""
          ? note
          : !r.ok
            ? "The Waiting list is a forge admin's."
            : r.value.length === 0
              ? "Nobody is waiting."
              : "a allows the selected request, d declines it.";
      s.text(head!.x, head!.y, truncate(text, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, body!, c, state, rows());
    },
    key(e) {
      note = "";
      if (state.key(e, items().length)) return true;
      if (e.ctrl || e.alt || !read().ok) return false;
      if (e.key === "a") return answer("allow");
      if (e.key === "d") return answer("decline");
      return false;
    },
  };
  return screen;
}

/** Who asked for an account and waits: a forge admin who is a person. */
export const entry: PaletteEntry = {
  id: "requests",
  title: "Waiting",
  hint: "strangers who asked for an account: allow or decline",
  after: ["invites", "teams", "limits", "quotas", "people", "can"],
  offered: (session) => session.user?.isAdmin === true && session.user.kind === "user",
  run: (session, ctx) => ctx.push(requestsScreen(session, ctx)),
};
