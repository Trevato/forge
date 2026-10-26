import { mayView } from "../../../core/sealed.ts";
import { listAssignedTo } from "../../../core/issues.ts";
import { canRead, getReposByIds } from "../../../core/repos.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "assigned",
  doc: "`{ limit? }`: the open issues and pulls assigned to you in every repository you can still read (repository, number, title, kind, state), as `GET /api/v1/user/assigned`",
  description: "Open issues and pulls assigned to you.",
  inputSchema: {
    type: "object",
    properties: { limit: { type: "integer", minimum: 1, maximum: 50 } },
  },
  writes: false,
  run(ctx, user, args) {
    const limit = args["limit"] ?? 50;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 50)
      return bad("invalid", "`limit` is a whole number from 1 to 50");
    const db = ctx.app.db;
    const issues = listAssignedTo(db, user.id, limit);
    const repos = getReposByIds(db, issues.map((i) => i.repoId));
    const items = [];
    for (const issue of issues) {
      const repo = repos.get(issue.repoId);
      if (!repo || !canRead(db, repo, user) || !mayView(db, repo, issue, user)) continue;
      items.push({ ...issue, repo: { owner: repo.ownerName, name: repo.name } });
    }
    return good({ items, next_cursor: null });
  },
};
