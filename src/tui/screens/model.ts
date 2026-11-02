/**
 * Model budget in the terminal, as `/settings/model` has it: a person sees
 * their own budget line and, with `a`, adds their own subscription (the token
 * typed masked, then an optional gateway). A forge admin who is not an agent
 * has a second command that sets or takes back an account's monthly grant.
 * Every rule is the action's (`actions/model_grant.ts`), the page's and the
 * API's the same.
 */

import {
  ADD_MESSAGES,
  addOwnModel,
  setAccountCeilings,
  setAccountGrant,
} from "../../actions/model_grant.ts";
import { AMOUNT_REFUSED, SUBSCRIPTION_ADDED } from "../../actions/model_words.ts";
import { getAccountCeiling } from "../../core/account_ceiling.ts";
import { getUserByName } from "../../core/users.ts";
import { budgetLine, ownSubscription } from "../../core/model_grant.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { blank, later, promptScreen } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

/** The signed-in person's budget line, and `a` to add their own subscription. */
export function modelScreen(f: Session, ctx: Ctx): Screen {
  let note = "";
  const screen: Screen = {
    title: "Model budget",
    keys: [binding(["a"], "add your subscription"), binding(["esc"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      const user = f.user;
      const own = user === undefined ? undefined : ownSubscription(f.app.db, user.id);
      const lines = [
        user === undefined ? "Sign in to see your model budget." : budgetLine(f.app.db, user, new Date()),
        own === undefined ? "a adds your own subscription, for your own repositories." : `Your subscription: ${own.name}`,
        note,
      ];
      lines.forEach((l, i) =>
        s.text(area.x, area.y + i, truncate(l, area.w), style(c.mutedFg, c.bg), area.x + area.w),
      );
    },
    key(e) {
      if (e.ctrl || e.alt || e.key !== "a") return false;
      ctx.push(
        promptScreen(ctx, screen, {
          title: "Add your subscription",
          label: "token (from `claude setup-token`, or an API key)",
          mask: true,
          onSubmit: (token) =>
            later(ctx, () =>
              promptScreen(ctx, screen, {
                title: "Add your subscription",
                label: "API base URL (empty for Anthropic)",
                onSubmit: (apiBase) => {
                  const added = addOwnModel(f.app, f.user, { token: token.trim(), apiBase: apiBase.trim() });
                  if (!added.ok) return ADD_MESSAGES[added.error];
                  note = SUBSCRIPTION_ADDED;
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

/** Admin: an account's name, then dollars a month (`none` takes the grant back). */
export function modelGrantPrompt(f: Session, ctx: Ctx, parent: Screen): Screen {
  return promptScreen(ctx, parent, {
    title: "Model grant",
    label: "account name",
    onSubmit: (name) =>
      later(ctx, () =>
        promptScreen(ctx, parent, {
          title: `Model grant for ${name.trim()}`,
          label: "dollars a month (none takes it back)",
          onSubmit: (raw) => {
            const text = raw.trim().toLowerCase();
            const usd = text === "none" || text === "0" ? null : Number(text);
            if (usd !== null && !Number.isFinite(usd)) return "Dollars a month, like 20 — or none.";
            const done = setAccountGrant(f.app, f.user, name.trim(), usd);
            if (!done.ok) return done.error === "invalid_amount" ? AMOUNT_REFUSED : "No such account.";
            ctx.toast(usd === null ? `${name.trim()}: grant taken back.` : `${name.trim()}: $${usd.toFixed(2)} a month.`);
            return undefined;
          },
        }),
      ),
  });
}

/** What an account's ceilings are now, for the prompt's label. */
function nowCeilings(f: Session, name: string): string {
  const user = getUserByName(f.app.db, name);
  const c = user === undefined ? undefined : getAccountCeiling(f.app.db, user.id);
  return c === undefined ? "now none" : `now $${c.dailyUsd.toFixed(2)} a day, $${c.perRunUsd.toFixed(2)} a run`;
}

/** Admin: an account's name (an organization's too), then its daily and per-run ceilings in dollars. */
export function modelCeilingPrompt(f: Session, ctx: Ctx, parent: Screen): Screen {
  return promptScreen(ctx, parent, {
    title: "Model ceiling",
    label: "account name",
    onSubmit: (name) =>
      later(ctx, () =>
        promptScreen(ctx, parent, {
          title: `Model ceiling for ${name.trim()}`,
          label: `${nowCeilings(f, name.trim())}; new: 20 5, or none`,
          onSubmit: (raw) => {
            if (raw.trim().toLowerCase() === "none") {
              const cleared = setAccountCeilings(f.app, f.user, name.trim(), null, null);
              if (!cleared.ok) return "No such account.";
              ctx.toast(`${name.trim()}: ceilings taken back.`);
              return undefined;
            }
            const [daily, perRun, ...rest] = raw.trim().split(/\s+/).map(Number);
            if (daily === undefined || perRun === undefined || rest.length > 0)
              return "Two amounts, like 20 5.";
            const done = setAccountCeilings(f.app, f.user, name.trim(), daily, perRun);
            if (!done.ok) return done.error === "invalid_amount" ? AMOUNT_REFUSED : "No such account.";
            ctx.toast(`${name.trim()}: $${done.value.dailyUsd?.toFixed(2)} a day, $${done.value.perRunUsd?.toFixed(2)} a run.`);
            return undefined;
          },
        }),
      ),
  });
}

/** A capped monthly grant to an account: a forge admin who is a person (#1145). */
export const modelGrantEntry: PaletteEntry = {
  id: "model-grant",
  title: "Model grant",
  hint: "give an account dollars a month, or take it back",
  after: ["model"],
  offered: (session) => session.user?.isAdmin === true && session.user.kind === "user",
  run: (session, ctx) => ctx.push(modelGrantPrompt(session, ctx, blank("Model grant"))),
};

/** An account's dollars a day and a run: a forge admin who is a person (#1145). */
export const modelCeilingEntry: PaletteEntry = {
  id: "model-ceiling",
  title: "Model ceiling",
  hint: "set an account's dollars a day and a run",
  after: ["model-grant"],
  offered: (session) => session.user?.isAdmin === true && session.user.kind === "user",
  run: (session, ctx) => ctx.push(modelCeilingPrompt(session, ctx, blank("Model ceiling"))),
};
