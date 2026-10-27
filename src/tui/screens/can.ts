/**
 * "What I can do" in the terminal, as the account page and the `whoami_can`
 * tool have it: the signed-in account's role and its row of the roles table,
 * and, where the platform edge signs people in, the open-platform.sh login
 * linked to the account; `u` unlinks it (SSH carries no edge header, so
 * linking is the web page's alone). An unverified email says so in one line
 * and what it holds back; `v` asks `resendVerification` for another link, as
 * the account page and MCP `email_verify` do, and says the outcome in the
 * API's words — never the link.
 */

import { ABILITIES, roleOf, rowOf, type Ability } from "../../core/roles.ts";
import { linkedLogin, unlinkEdgeLogin } from "../../core/edge_links.ts";
import { LAST_WAY_IN, linkedParent, parentIssuerOf, unlinkParent } from "../../core/federation.ts";
import { activeEdgeToken } from "../../http/edge.ts";
import { resendVerification } from "../../actions/verify.ts";
import { verifyWords } from "../../actions/verify_words.ts";
import { emailVerified } from "../../core/verify.ts";
import { isStandInEmail } from "../../core/users.ts";
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
  // Agents are always verified (`emailVerified`), so they are never offered `v`.
  const unverified = (): boolean =>
    f.user !== undefined && f.user.kind !== "agent" && !emailVerified(f.app.db, f.user.id);
  const mayResend = (): boolean => unverified() && !isStandInEmail(f.user!.email);
  let verifySaid: string | undefined;
  const verifyLine = (): string | undefined => {
    if (!unverified()) return undefined;
    const fix = mayResend() ? "v sends another link" : "add your email from account settings in a browser";
    return `Your email is not verified: until it is you can read and talk, but not make repositories, apps or runs. ${fix}.`;
  };
  const resend = async (): Promise<void> => {
    const sent = await resendVerification(f.app, f.user);
    verifySaid = verifyWords(sent.ok ? sent.value : sent.error);
  };
  return {
    title: "What I can do",
    get keys() {
      return [
        ...(mayResend() ? [binding(["v"], "send another verification email")] : []),
        binding(["u"], "unlink open-platform.sh"),
        binding(["p"], "unlink parent forge"),
        binding(["esc"], "back"),
      ];
    },
    render(area, s) {
      const c = ctx.theme.c;
      if (f.user === undefined) return;
      const role = roleOf(f.app.db, f.user);
      const row = rowOf(role);
      const login = edgeLogin();
      const verify = verifyLine();
      [`You are ${role} here.`, ...(verify === undefined ? [] : [verify]), ...(verifySaid === undefined ? [] : [verifySaid]), ...(login === undefined ? [] : [login]), ...(parentLine() === undefined ? [] : [parentLine()!]), ...(refused === undefined ? [] : [refused]), ...(Object.keys(ABILITIES) as Ability[]).map((a) => `${ABILITIES[a]}: ${row[a] ? "yes" : "no"}`)]
        .slice(0, Math.max(0, area.h))
        .forEach((l, i) => s.text(area.x, area.y + i, truncate(l, area.w), style(c.mutedFg, c.bg), area.x + area.w));
    },
    key(e) {
      if (e.ctrl || e.alt || (e.key !== "u" && e.key !== "p" && e.key !== "v") || f.user === undefined) return false;
      if (e.key === "v") {
        if (!mayResend()) return false;
        void ctx.track(resend());
        return true;
      }
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
