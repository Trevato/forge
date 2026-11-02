/**
 * An issue's plan in the terminal (#8707): the checklist a crew run keeps and
 * the state worked out from what it did, read through the same `readPlan` and
 * `shownState` as the page, so a person sees where a run is without its log.
 */

import type { IssuePlan } from "../../core/issue_plans.ts";
import type { ShownState } from "../../runs/state.ts";

/** The plan card's rows (plain text, truncated by the caller); none when there is no plan. */
export function planLines(plan: IssuePlan | undefined): string[] {
  if (plan === undefined || (plan.items.length === 0 && plan.ask === "")) return [];
  return [
    ...plan.items.map((i) => `${i.done ? "[x]" : "[ ]"} ${i.text}`),
    ...(plan.ask === "" ? [] : [`needs input: ${plan.ask}`]),
  ];
}

/** The card's title: how far along, and the state when it is one a person should act on. */
export function planTitle(plan: IssuePlan, shown: ShownState | undefined): string {
  const done = plan.items.filter((i) => i.done).length;
  const says = shown === "silent" || shown === "needs input" ? ` · ${shown}` : "";
  return `Plan · ${done} of ${plan.items.length} done${says}`;
}

/** The state to lead with for an issue's runs: the one that needs a person, else the newest run's. */
export function headline(shown: readonly ShownState[]): ShownState | undefined {
  return shown.find((s) => s === "needs input") ?? shown.find((s) => s === "silent") ?? shown[0];
}
