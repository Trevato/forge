import { changeTeam, planTeam, readTeams, TEAM_SAYS } from "../../../actions/teams.ts";
import { scopeAllows } from "../../../core/tokens.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "teams",
  description:
    "Crew teams for person admins: charter, dial (0–100) and member agents.",
  inputSchema: {
    type: "object",
    properties: {
      slug: { type: "string", maxLength: 64 },
      charter: { type: "string", maxLength: 2000 },
      dial: { type: "integer", minimum: 0, maximum: 100 },
      members: { type: "array", maxItems: 500, items: { type: "string", maxLength: 64 } },
      dryRun: { type: "boolean" },
    },
  },
  writes: true,
  doc: "`{ slug?, charter?, dial?, members?, dryRun? }`: the crew teams (person admins): without `slug` lists them; with it, changes charter, dial (0–100) or members, planned unless `dryRun` is false",
  dryByDefault: true,
  run(ctx, user, args) {
    const read = readTeams(ctx.app, user);
    if (!read.ok) return bad("not_found", "no such tool here");
    const slug = args["slug"];
    if (slug === undefined) return good({ teams: read.value.teams });
    const team = typeof slug === "string" ? read.value.teams.find((t) => t.slug === slug) : undefined;
    if (!team) return bad("not_found", `no team ${String(slug)}`);
    const { charter, dial, members } = args;
    if (
      (charter !== undefined && typeof charter !== "string") ||
      (dial !== undefined && typeof dial !== "number") ||
      (members !== undefined && (!Array.isArray(members) || !members.every((m) => typeof m === "string")))
    )
      return bad("invalid_body", "charter is text, dial a whole number, members a list of agent ids");
    const change = {
      ...(charter === undefined ? {} : { charter: charter as string }),
      ...(dial === undefined ? {} : { dial: String(dial) }),
      ...(members === undefined ? {} : { members: members as string[] }),
    };
    if (args["dryRun"] !== false) {
      // The plan is the real call's answer: the same checks, the same refusal.
      const plan = planTeam(ctx.app, user, team.slug, change);
      if (!plan.ok) return bad(plan.error, TEAM_SAYS[plan.error]);
      return good({
        says: `Would change ${team.name}${dial === undefined ? "" : ` from ${team.dial}% to ${String(dial)}%`}. Send dryRun: false to change it.`,
      });
    }
    if (!scopeAllows(ctx.auth.scope ?? "ro", "admin"))
      return bad("forbidden", "changing a team needs an admin-scope token");
    const changed = changeTeam(ctx.app, user, team.slug, change);
    if (!changed.ok) return bad(changed.error, TEAM_SAYS[changed.error]);
    return good({ says: `${changed.value.name} saved at ${changed.value.dial}%.`, ...changed.value });
  },
};
