import { addTeamMember, createTeam, deleteTeam, removeTeamMember } from "../../../actions/orgs.ts";
import { requireOrgAdmin } from "../../../actions/access.ts";
import { isTeamRole, TEAM_ROLES } from "../../../core/agents.ts";
import { getOrg, listTeamMemberRoles, listTeamMembers, listTeams, type Permission } from "../../../core/orgs.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "org_teams",
  doc: "`{ org, action, team, user?, permission?, role? }` (admin-scope token, an org owner): `create` a team (`permission` read, write or admin; read by default), `add_member` a `user` with an optional `role` (planner, builder, reviewer or member; setting it on someone already there changes their role), list its `members` with their roles, `remove_member` a `user` (with `role`, only that role comes off and they stay a member; without it they leave the team), or `remove` the team; the same as `/api/v1/orgs/:org/teams` and its `members`",
  description: "An org's teams: create, add member with a role, list members, remove.",
  inputSchema: {
    type: "object",
    properties: {
      org: { type: "string", maxLength: 64 },
      action: { type: "string", enum: ["create", "add_member", "members", "remove_member", "remove"] },
      team: { type: "string", maxLength: 64 },
      user: { type: "string", maxLength: 64 },
      permission: { type: "string", enum: ["read", "write", "admin"], description: "create" },
      role: { type: "string", enum: [...TEAM_ROLES], description: "add_member, remove_member: the seat on the crew" },
    },
    required: ["org", "action", "team"],
  },
  writes: true,
  needsAdminScope: true,
  run(ctx, user, args) {
    const org = getOrg(ctx.app.db, typeof args["org"] === "string" ? args["org"] : "");
    if (!org) return bad("not_found", "no such organization");
    const name = typeof args["team"] === "string" ? args["team"] : "";
    const action = args["action"];
    if (action === "create") {
      const p = args["permission"];
      const permission: Permission = p === "write" || p === "admin" ? p : "read";
      const made = createTeam(ctx.app, user, org, name, permission);
      return made.ok ? good(made.value) : bad(made.error, made.error);
    }
    const wanted = name.toLowerCase();
    const team = listTeams(ctx.app.db, org.id).find((t) => t.name.toLowerCase() === wanted);
    if (!team) return bad("not_found", "no such team");
    if (action === "add_member") {
      const role = args["role"];
      if (role !== undefined && !isTeamRole(role))
        return bad("bad_role", `role is one of ${TEAM_ROLES.join(", ")}`);
      const who = typeof args["user"] === "string" ? args["user"] : "";
      const added = addTeamMember(ctx.app, user, org, team, who, role);
      return added.ok ? good(added.value) : bad(added.error, added.error);
    }
    if (action === "remove_member") {
      const role = args["role"];
      if (role !== undefined && role !== "" && !isTeamRole(role))
        return bad("bad_role", `role is one of ${TEAM_ROLES.join(", ")}`);
      const who = typeof args["user"] === "string" ? args["user"] : "";
      const isMember = listTeamMembers(ctx.app.db, team.id).some(
        (m) => m.username.toLowerCase() === who.toLowerCase(),
      );
      const kept = role === "" ? undefined : role;
      const removed = removeTeamMember(ctx.app, user, org, team, who, kept);
      if (!removed.ok) return bad(removed.error, removed.error);
      if (!isMember || (kept !== undefined && !removed.value.removed))
        return bad("not_found", "no such member");
      return good({ removed: who, ...(kept ? { role: kept } : {}) });
    }
    if (action === "members") {
      // The same admin gate as the page: only an org admin manages its teams.
      if (!requireOrgAdmin(ctx.app, user, org).ok) return bad("not_found", "no such team");
      return good(
        listTeamMemberRoles(ctx.app.db, team.id).map((m) => ({ user: m.user.username, role: m.role })),
      );
    }
    if (action === "remove") {
      const gone = deleteTeam(ctx.app, user, org, team);
      return gone.ok ? good({ removed: team.name }) : bad(gone.error, gone.error);
    }
    return bad("invalid", "action is create, add_member, remove_member, members or remove");
  },
};
