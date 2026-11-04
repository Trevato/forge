/**
 * Set how much one seat (planner, builder, reviewer) may do at once (#7668):
 * the web form and the MCP `crew` tool both come here. A repository admin's
 * call (`updateRepoSettings` decides), as the autonomy form is; the MCP `crew`
 * tool adds its own refusal of an agent. It takes effect on the next tick (the picker reads
 * the repository row) and is on the trail as a `repo.settings_updated` line,
 * from what to what.
 */

import type { App } from "../app.ts";
import type { CrewRole } from "../core/agents.ts";
import type { Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { updateRepoSettings } from "./repos.ts";

export async function setSeatSlots(
  app: App,
  actor: User | undefined,
  repo: Repo,
  role: CrewRole,
  slots: number,
): Promise<Result<Repo, "not_found">> {
  const key = role === "planner" ? "plannerSlots" : role === "reviewer" ? "reviewerSlots" : "autonomySlots";
  const done = await updateRepoSettings(app, actor, repo, { [key]: slots });
  return done.ok ? ok(done.value) : err("not_found");
}

/** What a person is told. */
export function seatSlotsSaid(role: CrewRole, slots: number): string {
  if (slots === 0) return `The ${role} is paused: it stays on the crew and starts nothing until you raise it.`;
  return `The ${role} may do ${String(slots)} at once.`;
}
