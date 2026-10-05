/**
 * A spawned child's first boot (#575). `spawnForge` leaves the child a
 * `parent.json`, its apps with the spawner's words as their direction, and
 * the crew with the roles they had. The first time the child runs, this
 * opens the direction issue on its first app — the same issue the planner
 * is given when a map runs dry (`ensureDirectionIssue`) — and hands it to
 * the app's planner, so the crew starts on what the child is for. Once: the
 * child's organisation remembers that it booted, and a restart opens
 * nothing more. A forge that was not spawned has no `parent.json` and is
 * untouched.
 */

import { assignIssue } from "../actions/issues.ts";
import type { App } from "../app.ts";
import { listCrewRoles } from "../core/agents.ts";
import { listTeamMembers, listTeams, OWNERS_TEAM } from "../core/orgs.ts";
import { getRepoById, listReposByOwner } from "../core/repos.ts";
import { getUserSetting, setUserSetting } from "../core/settings.ts";
import { ensureDirectionIssue } from "../crew/autonomy.ts";
import { spawnedOrg } from "./claim.ts";

const BOOTED = "spawn_first_boot";

export async function firstBoot(app: App): Promise<void> {
  const spawned = await spawnedOrg(app);
  if (spawned === undefined) return;
  const owner = spawned.org;
  if (getUserSetting(app.db, owner.id, BOOTED) !== undefined) return;
  // The spawner's account: the organisation's first owner. It acts here only
  // to open and assign, as the spawner would have.
  const owners = listTeams(app.db, owner.id).find((t) => t.name === OWNERS_TEAM);
  const founder = owners === undefined ? undefined : listTeamMembers(app.db, owners.id)[0];
  if (!founder) return;
  setUserSetting(app.db, owner.id, BOOTED, new Date().toISOString());

  const first = listReposByOwner(app.db, owner.username, founder, { limit: 200 })
    .sort((a, b) => a.name.localeCompare(b.name))
    .find((r) => r.autonomyDirection.trim() !== "");
  if (!first) return;
  const issue = ensureDirectionIssue(app, founder, first);
  if (!issue) return;
  const repo = getRepoById(app.db, first.id) ?? first;
  const planner = listCrewRoles(app.db, repo.id).find((c) => c.role === "planner");
  if (planner && issue.assigneeId === null)
    assignIssue(app, founder, repo, issue, planner.agent.user);
}
