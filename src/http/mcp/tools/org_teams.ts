import { addTeamMember, createTeam, deleteTeam } from "../../../actions/orgs.ts";
import { getOrg, listTeams, type Permission } from "../../../core/orgs.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "org_teams",
  doc: "`{ org, action, team, user?, permission? }` (admin-scope token, an org owner): `create` a team (`permission` read, write or admin; read by default), `add_member` a `user`, or `remove` the team; the same as POST/DELETE `/api/v1/orgs/:org/teams`",
  description: "An org's teams: create, add member, remove.",
  inputSchema: {
    type: "object",
    properties: {
      org: { type: "string", maxLength: 64 },
      action: { type: "string", enum: ["create", "add_member", "remove"] },
      team: { type: "string", maxLength: 64 },
      user: { type: "string", maxLength: 64 },
      permission: { type: "string", enum: ["read", "write", "admin"], description: "create" },
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
      const added = addTeamMember(ctx.app, user, org, team, typeof args["user"] === "string" ? args["user"] : "");
      return added.ok ? good(added.value) : bad(added.error, added.error);
    }
    if (action === "remove") {
      const gone = deleteTeam(ctx.app, user, org, team);
      return gone.ok ? good({ removed: team.name }) : bad(gone.error, gone.error);
    }
    return bad("invalid", "action is create, add_member or remove");
  },
};
