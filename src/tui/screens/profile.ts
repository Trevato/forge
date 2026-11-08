/**
 * Your profile, in the terminal: username, display name and email, with `n`
 * and `e` to change the last two through `updateProfile` — the action behind
 * Settings › Account, refusing in the same words. A new email starts
 * verification exactly as it does on the web.
 */

import { emailSavedWords, PROFILE_FALLBACK, PROFILE_REFUSALS } from "../../actions/profile_words.ts";
import { updateProfile } from "../../actions/users.ts";
import { isStandInEmail } from "../../core/users.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { promptScreen } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

export function profileScreen(f: Session, ctx: Ctx): Screen {
  const save = (patch: { displayName: string } | { email: string }): string | undefined => {
    const r = updateProfile(f.app, f.user, patch);
    if (!r.ok) {
      const words = PROFILE_REFUSALS[r.error] ?? PROFILE_FALLBACK;
      ctx.toast(words, "danger");
      return words;
    }
    const emailChanged = "email" in patch && r.value.email.toLowerCase() !== f.user?.email.toLowerCase();
    f.user = r.value;
    ctx.toast(emailChanged ? emailSavedWords(r.value.email) : "saved", "success");
    ctx.invalidate();
    return undefined;
  };

  const screen: Screen = {
    title: "Your profile",
    keys: [binding(["n"], "set display name"), binding(["e"], "set email")],
    render(area, s) {
      const c = ctx.theme.c;
      const u = f.user;
      if (u === undefined) return;
      const email = isStandInEmail(u.email) ? "none" : u.email;
      const rows: [string, string][] = [
        ["Username", u.username],
        ["Display name", u.displayName],
        ["Email", email],
      ];
      rows.forEach(([k, v], i) => {
        const y = area.y + i;
        s.text(area.x, y, k.padEnd(14), style(c.mutedFg, c.bg), area.x + area.w);
        s.text(area.x + 14, y, truncate(v, Math.max(0, area.w - 14)), style(c.fg, c.bg), area.x + area.w);
      });
    },
    key(e) {
      if (e.ctrl || e.alt || f.user === undefined) return false;
      if (e.key === "n") {
        ctx.push(
          promptScreen(ctx, screen, {
            title: "Display name",
            label: "display name",
            value: f.user.displayName,
            onSubmit: (v) => save({ displayName: v }),
          }),
        );
        return true;
      }
      if (e.key === "e") {
        ctx.push(
          promptScreen(ctx, screen, {
            title: "Email",
            label: "email address",
            value: isStandInEmail(f.user.email) ? "" : f.user.email,
            onSubmit: (v) => save({ email: v }),
          }),
        );
        return true;
      }
      return false;
    },
  };
  return screen;
}

export const entry: PaletteEntry = {
  id: "profile",
  title: "Your profile",
  hint: "display name and email",
  offered: (session) => session.user !== undefined && session.user.kind !== "agent",
  run: (session, ctx) => ctx.push(profileScreen(session, ctx)),
};
