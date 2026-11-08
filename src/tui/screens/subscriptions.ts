/**
 * The crew's Claude subscriptions in the terminal, for whoever MCP
 * `subscriptions` admits (a forge admin): name, kind, what it pays for,
 * budget and spend, and whether it rests; never a token. `w` wakes the
 * selected resting one and `b` sets its whole-life budget, with the rules of
 * MCP `subscription_wake` and `subscription_budget` (the core's, not new ones).
 * `a` adds an account (name, token typed masked, optional API base) and `D`
 * removes the selected one after a confirm, as `subscription_add` and
 * `subscription_delete` do; an agent is offered neither.
 */

import {
  addSubscription,
  budgetRefusal,
  budgetsOf,
  deleteSubscription,
  getSubscription,
  isSubscriptionName,
  listSubscriptions,
  scopesOf,
  setBudget,
  wakeSubscription,
  type Subscription,
} from "../../core/subscriptions.ts";
import { windowWords } from "../../actions/standing_words.ts";
import { standings } from "../../core/standing.ts";
import { SUBSCRIPTION_WORDS, addRefusal } from "../../core/subscriptions_words.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, confirmScreen, drawList, later, promptScreen, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

const money = (n: number): string => `$${n.toFixed(2)}`;

export function subscriptionsScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  let note = "";
  const admitted = () => f.user?.isAdmin === true && f.user.kind === "user";

  // What the screen shows, read once on open and again after each change it
  // makes, so a keypress redraws from memory and never queries the database.
  let all: Subscription[] = [];
  let listed: ListRow[] = [];
  const load = (): void => {
    all = admitted() ? listSubscriptions(f.app.db) : [];
    const budgets = budgetsOf(f.app.db);
    const scopes = scopesOf(f.app.db);
    const seen = standings(f.app.db, all.map((a) => a.id), new Date());
    const now = Date.now();
    listed = all.map((s) => {
      const b = budgets.get(s.id);
      const resting = s.restingUntil !== null && Date.parse(s.restingUntil) > now;
      const pays = (scopes.get(s.id) ?? []).join(", ");
      const st = seen.get(s.id);
      return {
        title: s.name,
        tone: resting ? "attn" : "success",
        secondary: `${s.kind}  ${pays === "" ? "pays for nothing" : `pays for ${pays}`}`,
        meta:
          `${b?.budgetUsd == null ? "no budget" : `budget ${money(b.budgetUsd)}`}  spent ${money(b?.spentUsd ?? 0)}  ` +
          (resting ? `resting until ${s.restingUntil}` : "awake"),
        below:
          st === undefined || st.windows.every((w) => w.cap === null && w.resetsAt === null && w.used.value === 0)
            ? ["windows not seen yet"]
            : st.windows.map(windowWords),
      };
    });
  };
  load();

  const setTo = (id: string, raw: string): string | undefined => {
    const text = raw.trim().toLowerCase();
    const usd = text === "none" ? null : /^\d+(\.\d+)?$/.test(text) ? Number(text) : Number.NaN;
    if (usd !== null && !Number.isFinite(usd)) return "Dollars, like 25 — or none.";
    const refused = budgetRefusal(f.app.db, id, usd);
    if (refused) return refused.says.replace("or null for none", "or none");
    if (!setBudget(f.app.db, id, usd)) return "The budget was not saved.";
    load();
    note = usd === null ? "No budget: it spends until you stop it." : `Budget set: ${money(Math.round(usd * 100) / 100)} in all.`;
    ctx.invalidate();
    return undefined;
  };

  // The token is held only between its prompt and the base prompt, then handed over once.
  const tokenPrompt = (name: string): Screen =>
    promptScreen(ctx, screen, {
      title: `Token for ${name}`,
      label: "token (never shown again)",
      mask: true,
      onSubmit: (token) => {
        const given = token.trim();
        if (given === "") return SUBSCRIPTION_WORDS.invalid_token;
        return later(ctx, () =>
          promptScreen(ctx, screen, {
            title: `API base for ${name}`,
            label: "API base URL (empty is Anthropic)",
            onSubmit: (base) => {
              if (!admitted()) return "Only a forge admin adds an account.";
              const added = addSubscription(f.app.db, f.app.config.dataDir, {
                name,
                token: given,
                apiBase: base,
                createdBy: f.user?.id,
              });
              if (!added.ok) return addRefusal(added.error, name);
              load();
              note = `${added.value.name} is in the pool.`;
              ctx.invalidate();
              return undefined;
            },
          }),
        );
      },
    });

  const screen: Screen = {
    title: "Crew subscriptions",
    keys: [binding(["j", "k"], "move cursor"), binding(["w"], "wake"), binding(["b"], "set budget"), binding(["a"], "add"), binding(["D"], "remove"), binding(["esc"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      const [head, body] = split(area, "v", [len(1), fill(1)]);
      const text = note !== "" ? note : all.length === 0 ? "No subscription yet. a adds one." : "w wakes a resting one, b sets its budget, a adds, D removes.";
      s.text(head!.x, head!.y, truncate(text, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, body!, c, state, listed);
    },
    key(e) {
      note = "";
      if (state.key(e, all.length)) return true;
      if (e.ctrl || e.alt || !admitted()) return false;
      const sub = all[state.index];
      if (e.key === "w" && sub !== undefined) {
        const now = getSubscription(f.app.db, sub.id);
        if (now === undefined) note = "No such subscription.";
        else if (now.restingUntil === null || Date.parse(now.restingUntil) <= Date.now())
          note = `${sub.name} is awake already.`;
        else {
          wakeSubscription(f.app.db, sub.id);
          note = `${sub.name}: in use again.`;
        }
        load();
        ctx.invalidate();
      } else if (e.key === "b" && sub !== undefined) {
        ctx.push(
          promptScreen(ctx, screen, {
            title: `Budget for ${sub.name}`,
            label: "dollars in all (none clears it)",
            onSubmit: (raw) => setTo(sub.id, raw),
          }),
        );
      } else if (e.key === "a") {
        ctx.push(
          promptScreen(ctx, screen, {
            title: "Add a Claude account",
            label: "name, a word or two",
            onSubmit: (name) =>
              !isSubscriptionName(name) ? SUBSCRIPTION_WORDS.invalid_name : later(ctx, () => tokenPrompt(name)),
          }),
        );
      } else if (e.key === "D" && sub !== undefined) {
        ctx.push(
          confirmScreen(ctx, screen, {
            title: `Remove ${sub.name}?`,
            body: [
              `${sub.name} and its grants go.`,
              "Runs it paid for keep it in their history.",
            ],
            actions: [
              { label: "Remove", variant: "danger" },
              { label: "Cancel", variant: "ghost" },
            ],
            selected: 1,
            onChoose: (choice) => {
              if (choice !== 0 || !admitted()) return;
              note = deleteSubscription(f.app.db, sub.id) ? `${sub.name} is removed.` : SUBSCRIPTION_WORDS.not_found;
              load();
              state.clamp(all.length);
              ctx.invalidate();
            },
          }),
        );
      } else return false;
      return true;
    },
  };
  return screen;
}

/** The crew's Claude subscriptions, as MCP `subscriptions` has them: a forge admin (#7244). */
export const entry: PaletteEntry = {
  id: "subscriptions",
  title: "Crew subscriptions",
  hint: "each account's budget and rest; wake one, set its budget, add or remove one",
  after: ["invites", "teams", "limits", "quotas", "people", "can"],
  offered: (session) => session.user?.isAdmin === true && session.user.kind === "user",
  run: (session, ctx) => ctx.push(subscriptionsScreen(session, ctx)),
};
