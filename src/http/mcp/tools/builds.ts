import { listBuildPins } from "../../../git/builds.ts";
import { repoDir } from "../../../git/repos.ts";
import { good, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "builds",
  doc: "`{ repo }`: the repository's build pins, `{ items, next_cursor: null }`, as GET `/api/v1/repos/:owner/:name/builds` lists them (label, commit, who pinned it, note, parent, source); read-only, pinning stays with people on the page, the API and the terminal",
  description: "A repo's build pins (`refs/builds/`): label, commit, pinned by, note.",
  inputSchema: {
    type: "object",
    properties: { repo: REPO_ARG },
    required: ["repo"],
  },
  writes: false,
  async run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    return good({ items: await listBuildPins(repoDir(ctx.app.reposRoot, repo.ownerName, repo.name)), next_cursor: null });
  },
};
