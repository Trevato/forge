/**
 * People in the terminal, as `/settings/people` has them: every person with
 * a role and allowance, and `r` to make one a member (`member 5` gives a
 * starter $5 a month) or a guest. A forge admin who is a person; every rule
 * is the action's (`actions/roles.ts`). `s` suspends or lifts a suspension
 * after a confirm, with the actions and words MCP `account_suspend` uses.
 */

import { suspendAccount, unsuspendAccount } from "../../actions/accounts.ts";
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
import { confirmScreen, later, promptScreen, runAsync } from "./common.ts";

/** One person's row: name, role, allowance, and since when they are suspended. */
function rowOf(p: Person): string {
  const allowance = p.usdPerMonth === null ? "" : `  $${p.usdPerMonth.toFixed(2)} a month`;
  const suspended = p.suspendedAt === null ? "" : `  suspended ${p.suspendedAt.slice(0, 10)}`;
  return `${p.username}  ${p.role}${allowance}${suspended}`;
}

export function peopleScreen(f: Session, ctx: Ctx): Screen {
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
    keys: [binding(["r"], "change a role"), binding(["s"], "suspend or lift"), binding(["esc"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      listPeople(f.app.db)
        .slice(0, Math.max(0, area.h))
        .forEach((p, i) => {
          s.text(area.x, area.y + i, truncate(rowOf(p), area.w), style(c.mutedFg, c.bg), area.x + area.w);
        });
    },
    key(e) {
      if (e.ctrl || e.alt) return false;
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
