/**
 * Way-back links in the terminal, a forge admin's (#11802): the accounts the
 * platform edge made that have no way in of their own, as Settings →
 * Accounts lists them (`wayBackAccounts`). Enter mints the link with the same
 * action the page posts to (`mintWayBack`), behind the same gate, and shows
 * it once on a screen of its own; nothing keeps it once that is popped.
 */

import { mintWayBack, wayBackAccounts, type Stranded } from "../../actions/edge_handover.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, drawList, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";
import { hardWrap } from "./signins.ts";

const isAdmin = (f: Session): boolean => f.user?.isAdmin === true && f.user.kind === "user";

export function wayBackScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  let accounts: Stranded[] = [];
  let allowed = false;
  let note = "";
  const read = (): void => {
    const listed = wayBackAccounts(f.app, f.user);
    allowed = listed.ok;
    accounts = listed.ok ? listed.value : [];
    state.clamp(accounts.length);
  };
  read();
  const mint = (): void => {
    const picked = accounts[state.index];
    if (picked === undefined) return;
    const minted = mintWayBack(f.app, f.user, picked.username);
    if (!minted.ok) {
      note =
        minted.error === "has_way_in"
          ? `${picked.username} already signs in without the edge; no link was made.`
          : `${picked.username} is not there.`;
      read();
      ctx.invalidate();
      return;
    }
    note = "";
    const w = minted.value;
    ctx.push(linkScreen(ctx, w.username, w.login, w.url, w.expiresAt));
  };
  return {
    title: "Way-back links",
    keys: [binding(["j", "k"], "move cursor"), binding(["enter"], "make the link"), binding(["r"], "refresh")],
    render(area, s) {
      const c = ctx.theme.c;
      const [head, list] = split(area, "v", [len(1), fill(1)]);
      const text = !allowed
        ? "Not found."
        : note !== ""
          ? note
          : accounts.length === 0
            ? "Every account the edge made can sign in without it."
            : "Accounts the edge made with no way in of their own; enter makes one a way-back link.";
      s.text(head!.x, head!.y, truncate(text, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      const rows: ListRow[] = accounts.map((a) => ({ title: a.username, secondary: `edge login ${a.login}`, meta: "" }));
      drawList(s, list!, c, state, rows);
    },
    key(e) {
      if (e.ctrl || e.alt) return state.key(e, accounts.length);
      if (e.key === "enter") {
        if (allowed) mint();
        return true;
      }
      if (e.key === "r") {
        note = "";
        read();
        return true;
      }
      return state.key(e, accounts.length);
    },
  };
}

/** The link, alone on a screen, wrapped whole so a hand-copied line is the whole line. */
function linkScreen(ctx: Ctx, username: string, login: string, url: string, expiresAt: string): Screen {
  let copied = "";
  const until = `${expiresAt.slice(0, 16).replace("T", " ")} UTC`;
  return {
    title: `Way-back link for ${username}`,
    keys: [binding(["y"], "copy it"), binding(["esc", "q"], "done")],
    render(area, s) {
      const c = ctx.theme.c;
      const end = area.x + area.w;
      const lead = `Hand this to ${username} (edge login ${login}) by a channel you trust: it works once, until ${until}, and is not shown again.`;
      const said = hardWrap(lead, area.w);
      said.forEach((line, i) => s.text(area.x, area.y + i, line, style(c.mutedFg, c.bg), end));
      const top = area.y + said.length + 1;
      const lines = hardWrap(url, area.w);
      lines.forEach((line, i) => s.text(area.x, top + i, line, style(c.fg, c.bg), end));
      const foot = copied === "" ? "y copies it, esc is done." : copied;
      s.text(area.x, top + lines.length + 1, truncate(foot, area.w), style(c.mutedFg, c.bg), end);
    },
    key(e) {
      if (e.ctrl || e.alt) return true;
      if (e.key === "y") {
        ctx.copy(url);
        copied = "Copied.";
      } else if (e.key === "esc" || e.key === "q") {
        ctx.pop();
      }
      return true;
    },
  };
}

/** Settings → Accounts' way-back links: one per account the edge made with no way in. */
export const entry: PaletteEntry = {
  id: "way-back-links",
  title: "Way-back links",
  hint: "a link that signs in an account the edge made, once the edge is gone",
  after: ["edge-only-accounts"],
  offered: isAdmin,
  run: (session, ctx) => ctx.push(wayBackScreen(session, ctx)),
};
