/**
 * "What I can do" in the terminal, as the account page and the `whoami_can`
 * tool have it: the signed-in account's role and its row of the roles table,
 * and, where the platform edge signs people in, the open-platform.sh login
 * linked to the account; `u` unlinks it (SSH carries no edge header, so
 * linking is the web page's alone).
 */

import { ABILITIES, roleOf, rowOf, type Ability } from "../../core/roles.ts";
import { linkedLogin, unlinkEdgeLogin } from "../../core/edge_links.ts";
import { LAST_WAY_IN, linkedParent, parentIssuerOf, unlinkParent } from "../../core/federation.ts";
import { activeEdgeToken } from "../../http/edge.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";

export function canScreen(f: Session, ctx: Ctx): Screen {
  const edgeLogin = (): string | undefined => {
    if (f.user === undefined || activeEdgeToken(f.app) === undefined) return undefined;
    const linked = linkedLogin(f.app.db, f.user.id);
    return linked === undefined ? "open-platform.sh: not linked" : `open-platform.sh: linked as ${linked}`;
  };
  let refused: string | undefined;
  const parentLine = (): string | undefined => {
    const issuer = parentIssuerOf(f.app.config);
    if (f.user === undefined || issuer === undefined) return undefined;
    const host = new URL(issuer).host;
    return linkedParent(f.app.db, f.user.id, issuer) === undefined
      ? `${host}: not linked (link it from account settings in a browser)`
      : `${host}: linked`;
  };
  return {
    title: "What I can do",
    keys: [binding(["u"], "unlink open-platform.sh"), binding(["p"], "unlink parent forge"), binding(["esc"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      if (f.user === undefined) return;
      const role = roleOf(f.app.db, f.user);
      const row = rowOf(role);
      const login = edgeLogin();
      [`You are ${role} here.`, ...(login === undefined ? [] : [login]), ...(parentLine() === undefined ? [] : [parentLine()!]), ...(refused === undefined ? [] : [refused]), ...(Object.keys(ABILITIES) as Ability[]).map((a) => `${ABILITIES[a]}: ${row[a] ? "yes" : "no"}`)]
        .slice(0, Math.max(0, area.h))
        .forEach((l, i) => s.text(area.x, area.y + i, truncate(l, area.w), style(c.mutedFg, c.bg), area.x + area.w));
    },
    key(e) {
      if (e.ctrl || e.alt || (e.key !== "u" && e.key !== "p") || f.user === undefined) return false;
      if (e.key === "p") {
        const issuer = parentIssuerOf(f.app.config);
        const done = issuer === undefined ? undefined : unlinkParent(f.app.db, f.user.id, issuer);
        if (done?.ok === false) refused = LAST_WAY_IN;
        else if (done?.value === "unlinked") f.app.bus.append({ kind: "account.parent_unlinked", actorId: f.user.id });
        return true;
      }
      if (activeEdgeToken(f.app) !== undefined && unlinkEdgeLogin(f.app.db, f.user.id))
        f.app.bus.append({ kind: "account.edge_unlinked", actorId: f.user.id });
      return true;
    },
  };
}
