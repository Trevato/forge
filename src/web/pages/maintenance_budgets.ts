/**
 * The budgets of the maintenance duties (#11206), in each duty's row on /maintenance: per duty, what it has used
 * today against runs per day and dollars per day, the reason its default is what it is, and a
 * row to move either. A blank field, or the duty's own number, takes the duty's own back.
 */

import { budgetOf, parseBudget, setBudget, usedToday, DOLLARS_MAX, DOLLARS_MIN, RUNS_MAX } from "../../maintain/budget.ts";
import { duties } from "../../maintain/registry.ts";
import type { App } from "../../app.ts";
import type { Ctx } from "../../http/context.ts";
import { field as formField, readForm } from "../form.ts";
import { html, type Html } from "../html.ts";
import { flashTo } from "../layout.ts";
import { btn, field as formControl } from "../ui.ts";

/** What a duty's row says of its budget: use today, the reason, and the two inputs. */
export function budgetOfRow(app: App, name: string, now = new Date()): Html {
  const d = duties.find((x) => x.name === name);
  if (d === undefined) return html``;
  const b = budgetOf(app.db, d);
  const u = usedToday(app.db, d.name, now);
  const row = (label: string, value: Html): Html => html`<div class="status-row"><dt>${label}</dt><dd>${value}</dd></div>`;
  return html`${row(`${d.name} budget`, html`<span id="budget-${d.name}">${String(u.runs)} of ${String(b.runsPerDay)} runs, $${u.dollars.toFixed(2)} of $${b.dollarsPerDay.toFixed(2)} today</span>`)}
    ${row("Why", html`<span class="muted">${d.budget.reason}</span>`)}
    ${row("Change", html`<form method="post" action="/maintenance/budget" class="inline">
      <input type="hidden" name="duty" value="${d.name}" />
      ${formControl({ name: "runs", id: `runs-${d.name}`, label: "Runs per day", type: "number", min: 1, max: RUNS_MAX, value: String(b.runsPerDay), mono: true })}
      ${formControl({ name: "dollars", id: `dollars-${d.name}`, label: "Dollars per day", type: "number", min: DOLLARS_MIN, max: DOLLARS_MAX, step: "0.01", value: String(b.dollarsPerDay), mono: true })}
      ${btn("Save budget", { variant: "outline" })}
    </form>`)}`;
}

/** POST /maintenance/budget: an admin moves one duty's budgets; a blank value goes back to the duty's own. */
export async function maintenanceBudget(ctx: Ctx): Promise<Response> {
  const user = ctx.auth.user;
  if (user === undefined || !user.isAdmin || user.kind === "agent") return flashTo(ctx, "/maintenance", { tone: "danger", message: "Only a forge admin who is a person sets a budget." });
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const duty = duties.find((d) => d.name === formField(form, "duty"));
  if (duty === undefined) return flashTo(ctx, "/maintenance", { tone: "danger", message: "No such duty." });
  const picked: [("runs" | "dollars"), number | null][] = [];
  for (const kind of ["runs", "dollars"] as const) {
    const text = formField(form, kind).trim();
    const n = text === "" ? null : parseBudget(kind, text);
    if (n === undefined) return flashTo(ctx, "/maintenance", { tone: "danger", message: `${kind === "runs" ? "Runs per day" : "Dollars per day"} is outside what a budget takes.` });
    picked.push([kind, n]);
  }
  for (const [kind, n] of picked) setBudget(ctx.app.db, duty, kind, n, user.id);
  return flashTo(ctx, "/maintenance", { message: `Budget of ${duty.name} saved.` });
}
