import { ISSUE_TEAMS_SAY, nameTeams } from "../../../actions/issue_teams.ts";
import { teamsOfIssue } from "../../../core/issue_teams.ts";
import { good, bad, type Tool, REPO_ARG, repoArg, issueArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "issue_teams",
  description:
    "Name up to two crew teams to review.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      number: { type: "integer", minimum: 1 },
      teams: { type: "array", maxItems: 2, items: { type: "string", maxLength: 64 } },
    },
    required: ["repo", "number"],
  },
  writes: true,
  doc: "`{ repo, number, teams? }`: the crew teams an issue names; with `teams` (at most two slugs, `[]` clears) names them, and each reviews the closing pull",
  run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const issue = issueArg(ctx, repo, args, "number");
    if ("ok" in issue) return issue;
    const teams = args["teams"];
    if (teams === undefined) return good({ number: issue.number, teams: teamsOfIssue(ctx.app.db, issue.id) });
    if (!Array.isArray(teams) || !teams.every((t) => typeof t === "string"))
      return bad("invalid", "teams is a list of team slugs");
    const set = nameTeams(ctx.app, user, repo, issue, teams);
    if (!set.ok) return bad(set.error, ISSUE_TEAMS_SAY[set.error] ?? "that could not be changed");
    return good({
      number: issue.number,
      teams: set.value,
      says: set.value.length === 0 ? `#${issue.number} names no team.` : `#${issue.number} names ${set.value.join(" and ")}.`,
    });
  },
};
