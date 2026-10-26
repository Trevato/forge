import type { Repo } from "../../../core/repos.ts";
import { search } from "../../../actions/search.ts";
import { good, bad, type Tool, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "search",
  doc: "`{ q, kind?, repo? }`: issues, pulls, repositories and code you can read, the same results as /search; `repo` keeps to one",
  description:
    "Find issues, pulls, repositories and code you can read; `kind` and `repo` narrow.",
  inputSchema: {
    type: "object",
    properties: {
      q: { type: "string", minLength: 1, maxLength: 200 },
      kind: { type: "string", enum: ["issues", "repos", "code"] },
      repo: { type: "string", maxLength: 140 },
    },
    required: ["q"],
  },
  writes: false,
  async run(ctx, user, args) {
    const q = args["q"];
    if (typeof q !== "string" || q.trim() === "" || q.length > 200)
      return bad("invalid", "`q` is 1 to 200 characters");
    const kind = args["kind"];
    if (kind !== undefined && kind !== "issues" && kind !== "repos" && kind !== "code")
      return bad("invalid", "`kind` is issues, repos or code");
    let only: Repo | undefined;
    if (args["repo"] !== undefined) {
      if (typeof args["repo"] !== "string") return bad("invalid", "`repo` is owner/name");
      const repo = repoArg(ctx, user, args);
      if (isAnswer(repo)) return repo;
      only = repo;
    }
    return good(
      await search(ctx.app, user, {
        q,
        ...(kind ? { kind } : {}),
        ...(only ? { repo: only } : {}),
      }),
    );
  },
};
