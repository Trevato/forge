import { iterationsOf, lanesOf } from "../../../core/iterations.ts";
import { good, type Tool, repoArg, isAnswer, str } from "../shared.ts";

export const tool: Tool = {
  name: "iterations",
  doc: "`{ owner, name }`: the repository's fork family of builds, `{ forks, lanes }`, as GET `/api/v1/repos/:owner/:name/iterations` answers it and the Iterations page draws it (`forks`: each `{ repo, name, forkOf, builds: [{ key, label, oid, at, note, parent, edge }] }`; `lanes`: the tree's runs in drawing order); at most 40 repositories, a private fork the caller may not read is absent, a family with no pin answers empty lists; read-only",
  description: "A repo's fork family of build pins and runs, as the Iterations page draws them.",
  inputSchema: {
    type: "object",
    properties: { owner: { type: "string" }, name: { type: "string" } },
    required: ["owner", "name"],
  },
  writes: false,
  async run(ctx, user, args) {
    const repo = repoArg(ctx, user, { repo: `${str(args["owner"])}/${str(args["name"])}` });
    if (isAnswer(repo)) return repo;
    const forks = (await iterationsOf(ctx.app, user, repo)) ?? [];
    return good({ forks, lanes: lanesOf(forks) });
  },
};
