/**
 * The forge's plans in the terminal, a forge admin's: every plan with its
 * size, price, monthly crew credit and forge count, as /admin/limits and MCP
 * `limits` show them. `e` asks for `<field> <value>` (price, credit, forges,
 * size, name or words), shows the change and applies it only after a confirm,
 * through `editPlans`, so the words of a refusal are the page's and the MCP's.
 * The gate is the action's: an admin who is a person; anyone else sees nothing.
 */

import { editPlans, readPlans } from "../../actions/plans.ts";
import type { Plan } from "../../settings/plans.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, confirmScreen, drawList, promptScreen, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

const FIELDS: Readonly<Record<string, keyof Plan>> = {
  name: "name",
  words: "says",
  size: "size",
  price: "priceUsd",
  credit: "creditUsd",
  forges: "forges",
};
const NUMERIC = new Set<keyof Plan>(["priceUsd", "creditUsd", "forges"]);
const ASK = `${Object.keys(FIELDS).join(", ")} then a value, e.g. credit 6`;

/** `credit 6` as the plan field and the value the form would send, or the sentence that says what is wrong. */
function parseEdit(raw: string): { field: keyof Plan; value: string | number } | string {
  const m = /^(\S+)\s+(.+)$/.exec(raw.trim());
  const field = m === null ? undefined : FIELDS[m[1]!.toLowerCase()];
  if (m === null || field === undefined) return ASK;
  const text = m[2]!.trim();
  if (!NUMERIC.has(field)) return { field, value: text };
  return /^\d{1,7}(\.\d{1,2})?$/.test(text) ? { field, value: Number(text) } : `${m[1]} is a number`;
}

export function plansScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  let note = "";
  const all = (): Plan[] => (f.user?.isAdmin === true && f.user.kind !== "agent" ? readPlans(f.app) : []);

  const apply = (plan: Plan, field: keyof Plan, value: string | number): void => {
    const made = editPlans(f.app, f.user, { [plan.key]: { [field]: value } });
    note = made.ok
      ? `${plan.key}: ${field} is now ${value}, from the next spawn on.`
      : made.error === "not_found"
        ? "You cannot change plans."
        : `${made.error.invalid}.`;
    ctx.invalidate();
  };

  const ask = (plan: Plan): void => {
    ctx.push(
      promptScreen(ctx, screen, {
        title: plan.key,
        label: ASK,
        hint: `now ${plan.size} · $${plan.priceUsd}/mo · $${plan.creditUsd} crew credit · ${plan.forges} forges`,
        onSubmit: (raw) => {
          const edit = parseEdit(raw);
          if (typeof edit === "string") return edit;
          return Promise.resolve().then(() => {
            ctx.push(
              confirmScreen(ctx, screen, {
                title: "Change this plan",
                body: [`${plan.key}: ${edit.field} ${String(plan[edit.field])} → ${edit.value}`],
                actions: [{ label: "Keep", variant: "ghost" }, { label: "Change" }],
                onChoose: (i) => {
                  if (i === 1) apply(plan, edit.field, edit.value);
                },
              }),
            );
          });
        },
      }),
    );
  };

  const rows = (plans: readonly Plan[]): ListRow[] =>
    plans.map((p) => ({
      title: `${p.key} · ${p.name}`,
      secondary: `${p.size} · $${p.priceUsd}/mo · $${p.creditUsd} crew credit · ${p.forges} forges`,
      meta: p.says,
    }));

  const screen: Screen = {
    title: "Plans",
    keys: [binding(["j", "k"], "move cursor"), binding(["e"], "change")],
    render(area, s) {
      const c = ctx.theme.c;
      const [head, list] = split(area, "v", [len(1), fill(1)]);
      const plans = all();
      const text = note !== "" ? note : plans.length > 0 ? "What a spawn on each plan gets. e changes one." : "Plans are set by a forge admin.";
      s.text(head!.x, head!.y, truncate(text, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, list!, c, state, rows(plans));
    },
    key(e) {
      const plans = all();
      if (state.key(e, plans.length)) return true;
      if (e.ctrl || e.alt || e.key !== "e") return false;
      const plan = plans[state.index];
      if (plan === undefined) return false;
      ask(plan);
      return true;
    },
  };
  return screen;
}

/** The forge's plans, as /admin/limits has them: an admin who is not an agent. */
export const entry: PaletteEntry = {
  id: "plans",
  title: "Plans",
  hint: "free, small, medium and large: size, price, crew credit, forges; change one",
  after: ["limits"],
  offered: (session: Session) => session.user?.isAdmin === true && session.user.kind !== "agent",
  run: (session, ctx) => ctx.push(plansScreen(session, ctx)),
};
