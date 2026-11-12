/**
 * The planner's switch (#11604): the owner pauses the repository's planner until a time, the
 * weekly reset or their own word, or switches it on. One action for the page and the API; the
 * rule (what a pause stops) lives in `core/planner_pause.ts`.
 */

import type { App } from "../app.ts";
import { canAdmin, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { FOREVER, nextWeek, pausePlanner, pausedUntil, resumePlanner } from "../core/planner_pause.ts";
import { weekCapacity } from "../flow/week.ts";

export type SwitchInput =
  | { readonly mode: "on" }
  | { readonly mode: "until"; readonly at: string }
  | { readonly mode: "week" }
  | { readonly mode: "owner" };

export type SwitchError = "not_found" | "forbidden" | "invalid";

/** Sets the switch; the value is when the pause lifts, or null when the planner is on. */
export function setPlannerSwitch(
  app: App,
  actor: User | undefined,
  repo: Repo,
  input: SwitchInput,
  now = new Date(),
): Result<string | null, SwitchError> {
  if (actor === undefined) return err("not_found");
  if (actor.kind === "agent" || !canAdmin(app.db, repo, actor)) return err("forbidden");
  if (input.mode === "on") resumePlanner(app.db, repo.id);
  else {
    let until: string;
    if (input.mode === "owner") until = FOREVER;
    else if (input.mode === "week") {
      const reset = weekCapacity(app.db, now)?.resetsAt ?? null;
      until = reset !== null && reset > now.toISOString() ? reset : nextWeek(now);
    } else {
      const t = Date.parse(input.at);
      if (!Number.isFinite(t) || t <= now.getTime() || t > now.getTime() + 366 * 86_400_000) return err("invalid");
      until = new Date(t).toISOString();
    }
    pausePlanner(app.db, repo.id, until, actor.id);
  }
  const until = pausedUntil(app.db, repo.id, now);
  app.bus.append({
    kind: until === null ? "planner.resumed" : "planner.paused",
    repoId: repo.id,
    actorId: actor.id,
    payload: { until },
  });
  return ok(until);
}

/** A `datetime-local` value (minutes or seconds, no zone) is UTC, as the page says; anything else goes through as typed. */
export function utcAt(at: string): string {
  const t = at.trim();
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/.test(t) ? `${t.length === 16 ? `${t}:00` : t}Z` : t;
}

/** The switch's input from a form or the terminal's words; undefined when it is none of them. */
export function switchInput(mode: string, at: string): SwitchInput | undefined {
  if (mode === "on" || mode === "week" || mode === "owner") return { mode };
  return mode === "until" ? { mode, at: utcAt(at) } : undefined;
}
