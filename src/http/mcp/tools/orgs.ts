import { getOrg, listOrgsForUser, listTeamMembers, listTeamsVisibleTo } from "../../../core/orgs.ts";
import { publicProfile } from "../../respond.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "orgs",
  doc: "`{ org? }`: without `org`, the organizations you belong to; with it, the organization, the teams you may see and each team's members; the same as GET `/api/v1/user/orgs`, `/api/v1/orgs/:org`, `…/teams` and `…/members`",
  description: "Your orgs; with org, its teams.",
  inputSchema: {
    type: "object",
    properties: { org: { type: "string" } },
  },
  writes: false,
  run(ctx, user, args) {
    const org = args["org"];
    if (org === undefined) return good(listOrgsForUser(ctx.app.db, user.id).map(publicProfile));
    const found = typeof org === "string" ? getOrg(ctx.app.db, org) : undefined;
    if (!found) return bad("not_found", "no such organization");
    // Only the teams the caller may see, as the API lists them; a stranger sees none.
    const teams = listTeamsVisibleTo(ctx.app.db, found.id, user).map((t) => ({
      ...t,
      members: listTeamMembers(ctx.app.db, t.id).map(publicProfile),
    }));
    return good({ id: found.id, ...publicProfile(found), teams });
  },
};
