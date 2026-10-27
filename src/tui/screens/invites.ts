/**
 * Invite links in the terminal, a forge admin's (#2337): every link with its
 * state, when it was made and when it expires, as Invite links on /admin/limits
 * shows them. `m` mints one from a number of days (1 to 30, 7 by default) and
 * prints the link once, on this screen, until the next key of any kind; `x` revokes the
 * selected open one. Both go through the actions, so the gate is theirs: an
 * admin who is a person; anyone else sees nothing and mints nothing. The top
 * line says who may sign up now, as MCP `signup` does; `s` picks open, invite
 * or closed, shows from → to and changes it only after a confirm.
 */

import { inviteLink, list, mint, revoke } from "../../actions/invites.ts";
import { INVITE_NOT_OPEN } from "../../actions/sever_invite_words.ts";
import { changeSignup, readSignup } from "../../actions/signup.ts";
import { SIGNUP_MODES, type SignupMode } from "../../settings/signup.ts";
import { DEFAULT_DAYS, MAX_DAYS } from "../../core/invites.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, confirmScreen, drawList, pickerScreen, promptScreen, type ListRow } from "./common.ts";

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

  const signup = () => readSignup(f.app, f.user);

  const plan = (to: SignupMode): void => {
    const now = signup();
    if (!now.ok || now.value.signup === to) return;
    const from = now.value.signup;
    ctx.push(
      confirmScreen(ctx, screen, {
        title: "Sign-ups",
        body: [`Would set signup from ${from} to ${to}.`],
        actions: [{ label: "Change" }, { label: "Cancel" }],
        onChoose: (i) => {
          if (i !== 0) return;
          const changed = changeSignup(f.app, f.user, to);
          note = changed.ok ? `signup: ${from} → ${changed.value}.` : "You cannot change sign-ups.";
          ctx.invalidate();
        },
      }),
    );
  };

  const rows = (): ListRow[] =>
    items().map((i) => ({
      title: i.id,
      secondary: i.state,
      meta: `made ${i.createdAt.slice(0, 16)}  expires ${i.expiresAt.slice(0, 16)}`,
    }));

  const screen: Screen = {
    title: "Invite links",
    // A getter: the help reads it each time, and `s` is listed only when it works.
    get keys() {
      return [
        binding(["j", "k"], "move cursor"),
        binding(["m"], "make a link"),
        binding(["x"], "revoke"),
        ...(signup().ok ? [binding(["s"], "who may sign up")] : []),
      ];
    },
    render(area, s) {
      const c = ctx.theme.c;
      const r = read();
      const sg = signup();
      const [top, head, body] = split(area, "v", [len(sg.ok ? 1 : 0), len(1), fill(1)]);
      if (sg.ok)
        s.text(top!.x, top!.y, truncate(`signup: ${sg.value.signup}. s changes it.`, top!.w), style(c.fg, c.bg), top!.x + top!.w);
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
        note = revoke(f.app, f.user, row.id).ok ? `Revoked ${row.id}.` : INVITE_NOT_OPEN;
        ctx.invalidate();
      } else if (e.key === "s") {
        const now = signup();
        if (!now.ok) return false;
        ctx.push(
          pickerScreen(ctx, screen, {
            title: "Who may sign up",
            items: SIGNUP_MODES.map((m) => ({
              id: m,
              label: m,
              ...(m === now.value.signup ? { hint: "now" } : {}),
            })),
            onPick: ([m]) => plan(m as SignupMode),
          }),
        );
      } else return false;
      return true;
    },
  };
  return screen;
}
