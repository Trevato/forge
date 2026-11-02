import type { Repo } from "../../../core/repos.ts";
import { search, searchRefusal } from "../../../actions/search.ts";
import { CODE_BUDGET_MS, searchKind, searchNote } from "../../../core/search.ts";
import { good, bad, type Tool, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "search",
  doc: "`{ q, kind?, limit?, repo?, all? }`: issues, pulls, repositories and code you can read, the same results as /search; `repo` keeps to one; `moreCode` says the code grep stopped at its budget, `all` greps the rest",
  description:
    "Find issues, pulls, repositories and code you can read; `kind` and `repo` narrow.",
  inputSchema: {
    type: "object",
    properties: {
      q: { type: "string", maxLength: 200 },
      kind: { type: "string", enum: ["all", "issues", "repos", "code"] },
      limit: { type: "integer" },
      repo: { type: "string", maxLength: 140 },
      all: { type: "boolean" },
    },
    required: ["q"],
  },
  writes: false,
  async run(ctx, user, args) {
    const q = args["q"];
    if (typeof q !== "string" || q.length > 200) return bad("invalid", "`q` is a string of at most 200 characters");
    const kind = args["kind"];
    if (kind !== undefined && typeof kind !== "string") return bad("invalid_kind", "kind is all, repos, issues or code");
    const refusal = searchRefusal(kind, args["limit"] === undefined || typeof args["limit"] === "number" ? (args["limit"] as number | undefined) : NaN);
    if (refusal) return bad(refusal.code, refusal.message);
    const all = args["all"];
    if (all !== undefined && typeof all !== "boolean") return bad("invalid", "`all` is true or false");
    let only: Repo | undefined;
    if (args["repo"] !== undefined) {
      if (typeof args["repo"] !== "string") return bad("invalid", "`repo` is owner/name");
      const repo = repoArg(ctx, user, args);
      if (isAnswer(repo)) return repo;
      only = repo;
    }
    const note = searchNote(q);
    const found = await search(ctx.app, user, {
      q,
      ...(kind ? { kind: searchKind(kind) } : {}),
      ...(typeof args["limit"] === "number" ? { limit: args["limit"] } : {}),
      ...(only ? { repo: only } : {}),
      ...(all === true ? {} : { codeBudgetMs: ctx.app.config.codeBudgetMs ?? CODE_BUDGET_MS }),
    });
    return good(note === undefined ? found : { ...found, note });
  },
};
