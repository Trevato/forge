/** An issue's plan, where the thread begins (#8707): the crew run's checklist, so a person sees where it is without a log. */

import { getIssuePlan } from "../../core/issue_plans.ts";
import type { Database } from "bun:sqlite";
import type { Issue } from "../../core/issues.ts";
import { html, type Html } from "../html.ts";
import { badge, listCard, row, time } from "../ui.ts";

/** The card, or nothing when the issue has no plan. A finished item and a question each say so in a word, not only in a mark. */
export function planCard(db: Database, issue: Issue): Html | null {
  const plan = getIssuePlan(db, issue.id);
  if (plan === undefined || (plan.items.length === 0 && plan.ask === "")) return null;
  const done = plan.items.filter((i) => i.done).length;
  const rows = [
    ...(plan.ask === "" ? [] : [row({ title: plan.ask, trail: badge("Needs input", { tone: "attn" }) })]),
    ...plan.items.map((i) =>
      row({ title: i.text, trail: i.done ? badge("done", { tone: "success" }) : badge("to do", { variant: "outline" }) }),
    ),
  ];
  return listCard(rows, {
    id: "plan",
    extra: "mt",
    head: html`<span class="muted small">Plan · ${String(done)} of ${String(plan.items.length)} done · ${time(plan.updatedAt)}</span>`,
  });
}
