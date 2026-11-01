/**
 * People in the terminal, as `/settings/people` has them: every person with
 * a role and allowance, and `r` to make one a member (`member 5` gives a
 * starter $5 a month) or a guest. A forge admin who is a person; every rule
 * is the action's (`actions/roles.ts`). `s` suspends or lifts a suspension
 * after a confirm, with the actions and words MCP `account_suspend` uses.
 * `v` vouches for the email of the person under the cursor, after a y/n,
 * with the action MCP `account_verify` uses. Without mail a line above the
 * list says so, as the accounts page's card does.
 */

import { suspendAccount, unsuspendAccount, verifyAccount } from "../../actions/accounts.ts";
import { mailConfigured } from "../../actions/verify.ts";
import { ADMIN_WORDS } from "../../actions/admin_words.ts";
import { lastOwnerSays } from "../../core/orgs.ts";
import { setRole } from "../../actions/roles.ts";
import { AMOUNT_REFUSED } from "../../actions/model_words.ts";
import { listPeople, type Person } from "../../core/roles.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { confirmScreen, drawList, later, ListState, promptScreen, runAsync, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

/**
 * The accounts page's no-mail card in one line that fits 80 columns: without
 * mail a newcomer cannot prove an address, so the admin's word is the way in.
 */
export const NO_MAIL_LINE = "Mail is not configured: verify newcomers here with v, or set MAIL_SMTP_URL.";

/** One person's row: name, role, allowance, and since when they are suspended. */
function rowOf(p: Person): string {
  const allowance = p.usdPerMonth === null ? "" : `  $${p.usdPerMonth.toFixed(2)} a month`;
  const suspended = p.suspendedAt === null ? "" : `  suspended ${p.suspendedAt.slice(0, 10)}`;
  return `${p.username}  ${p.role}${allowance}${suspended}`;
}

export function peopleScreen(f: Session, ctx: Ctx): Screen {
  const list = new ListState();
  // Read once per open: the answer lists the forge's secrets.
  const noMail = !mailConfigured(f.app);
  const verify = (name: string): void => {
    const done = verifyAccount(f.app, f.user, name);
    if (done.ok) ctx.toast(`${done.value.username}'s email is verified.`);
    else
      ctx.toast(
        done.error === "not_found" ? "No such account." : "An agent or a removed account has no email to verify.",
        "danger",
      );
  };
  const askSuspend = (username: string, suspend: boolean): void => {
    later(ctx, () =>
      confirmScreen(ctx, screen, {
        title: suspend ? `Suspend ${username}` : `Lift ${username}'s suspension`,
        body: [
          suspend
            ? `${username}'s sessions and tokens stop at once. Suspend this account?`
            : `${username} can sign in again, with a new session. Lift the suspension?`,
        ],
        actions: [suspend ? { label: "Suspend", variant: "danger" } : { label: "Lift" }, { label: "Cancel" }],
        selected: 1,
        onChoose: (choice) => {
          if (choice !== 0) return;
          runAsync(ctx, async () => {
            const done = suspend ? await suspendAccount(f.app, f.user, username) : unsuspendAccount(f.app, f.user, username);
            if (done.ok) return ctx.toast(suspend ? `${username} is suspended.` : `${username} is lifted.`);
            const words =
              done.error === "not_found"
                ? "No such person."
                : done.error === "last_owner"
                  ? lastOwnerSays(f.app.db, username)
                  : done.error === "not_allowed"
                    ? ADMIN_WORDS.selfSuspend
                    : "That did not work.";
            ctx.toast(words, "danger");
          });
        },
      }),
    );
  };
  const screen: Screen = {
    title: "People",
    keys: [binding(["r"], "change a role"), binding(["s"], "suspend or lift"), binding(["v"], "verify"), binding(["esc"], "back")],
    render(area, s) {
      const rows: ListRow[] = listPeople(f.app.db).map((p) => ({
        title: rowOf(p),
        ...(p.verified ? {} : { meta: "unverified" }),
      }));
      const c = ctx.theme.c;
      if (noMail && area.h > 1) {
        s.text(area.x, area.y, truncate(NO_MAIL_LINE, area.w), style(c.attn, c.bg), area.x + area.w);
        area = { ...area, y: area.y + 2, h: Math.max(0, area.h - 2) };
      }
      drawList(s, area, c, list, rows);
    },
    key(e) {
      const people = listPeople(f.app.db);
      if (list.key(e, people.length)) return true;
      if (e.ctrl || e.alt) return false;
      if (e.key === "v") {
        const p = people[list.index];
        if (f.user?.isAdmin !== true || f.user.kind !== "user") ctx.toast("Only a forge admin can verify an email.", "danger");
        else if (p === undefined) return true;
        else if (p.verified) ctx.toast(`${p.username}'s email is already verified.`, "danger");
        else
          ctx.push(
            confirmScreen(ctx, screen, {
              title: "Verify email",
              body: [`verify ${p.username}'s email? y/n`],
              actions: [{ label: "Verify" }, { label: "Cancel" }],
              selected: 1,
              yesNo: true,
              onChoose: (choice) => {
                if (choice === 0) verify(p.username);
              },
            }),
          );
        return true;
      }
      if (e.key === "s") {
        ctx.push(
          promptScreen(ctx, screen, {
            title: "Suspend or lift",
            label: "account name",
            onSubmit: (name) => {
              const username = name.trim();
              const person = listPeople(f.app.db).find((p) => p.username === username);
              if (person === undefined) return "No such account, or not one a suspension is for.";
              askSuspend(username, person.suspendedAt === null);
              return undefined;
            },
          }),
        );
        return true;
      }
      if (e.key !== "r") return false;
      ctx.push(
        promptScreen(ctx, screen, {
          title: "Change a role",
          label: "account name",
          onSubmit: (name) =>
            later(ctx, () =>
              promptScreen(ctx, screen, {
                title: `Role for ${name.trim()}`,
                label: "guest, member, or member 5 (dollars a month)",
                onSubmit: (raw) => {
                  const [role, amount, ...rest] = raw.trim().toLowerCase().split(/\s+/);
                  if ((role !== "member" && role !== "guest") || rest.length > 0 || (amount !== undefined && role !== "member"))
                    return "guest, member, or member 5.";
                  const usd = amount === undefined ? null : Number(amount);
                  if (usd !== null && !Number.isFinite(usd)) return "Dollars a month, like 5.";
                  const done = setRole(f.app, f.user, name.trim(), role, usd);
                  if (!done.ok) return done.error === "invalid_amount" ? AMOUNT_REFUSED : "No such account, or not one a role is for.";
                  ctx.toast(`${name.trim()} is a ${role}.`);
                  return undefined;
                },
              }),
            ),
        }),
      );
      return true;
    },
  };
  return screen;
}

/** Guests, members and admins, as /settings/people has them (#2301). */
export const entry: PaletteEntry = {
  id: "people",
  title: "People",
  hint: "who is a guest, a member or an admin; promote or demote",
  after: ["can"],
  offered: (session) => session.user?.isAdmin === true && session.user.kind === "user",
  run: (session, ctx) => ctx.push(peopleScreen(session, ctx)),
};
