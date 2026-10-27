import { getUserByName } from "../../../core/users.ts";
import { ARCHIVED_WHY } from "../../../core/repos.ts";
import { NOT_A_MEMBER } from "../../../core/roles.ts";
import { AGENT_NOT_ON_CREW } from "../../../actions/crew_limit_words.ts";
import { assignIssue } from "../../../actions/issues.ts";
import { good, bad, type Tool, REPO_ARG, repoArg, issueArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "assign",
  doc: "`{ repo, number, kind, assignee }`: assign an issue or pull (`kind` is `issue` or `pull`) to a user, or clear it with `null`, as `PUT …/assignee` and with its refusals",
  description: "Assign an issue or pull to a user, or clear (null); PUT refusals apply.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      number: { type: "integer", minimum: 1 },
      kind: { type: "string", enum: ["issue", "pull"] },
      assignee: { type: ["string", "null"] },
    },
    required: ["repo", "number", "kind", "assignee"],
  },
  writes: true,
  run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const kind = args["kind"];
    if (kind !== "issue" && kind !== "pull") return bad("invalid", "kind is issue or pull");
    const name = args["assignee"];
    if (name !== null && typeof name !== "string")
      return bad("invalid_assignee", "assignee must be a username or null");
    const issue = issueArg(ctx, repo, args, "number");
    if ("ok" in issue) return issue;
    if (issue.kind !== kind) return bad("no_such_issue", `no ${kind} #${issue.number}`);
    const assignee = name === null || name === "" ? null : getUserByName(ctx.app.db, name);
    if (assignee === undefined) return bad("no_such_user", `no account named ${name}`);
    const done = assignIssue(ctx.app, user, repo, issue, assignee);
    if (!done.ok) {
      const e = done.error;
      if (e === "not_found") return bad("not_found", "no such app or repository (owner/name)");
      if (e === "unverified") return bad(e, "verify your email first");
      if (e === "archived") return bad(e, ARCHIVED_WHY);
      if (e === "not_member") return bad(e, NOT_A_MEMBER);
      if (e === "assignee_cannot_read") return bad(e, "the assignee cannot read this repository");
      if (e === "agent_not_on_crew") return bad(e, AGENT_NOT_ON_CREW);
      if (user.kind === "agent" && e === "forbidden")
        return bad(e, "an agent may not assign; that is a person's call");
      if (e === "forbidden" || e === "unauthorized")
        return bad(e, "your credentials lack the scope for this action");
      return bad(e, "that assignment could not be made");
    }
    return good({
      says: assignee
        ? `#${issue.number} is assigned to ${assignee.username}.`
        : `#${issue.number} is unassigned.`,
      number: issue.number,
      kind,
      assignee: assignee?.username ?? null,
    });
  },
};
