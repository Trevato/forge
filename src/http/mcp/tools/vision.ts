import { canAdmin } from "../../../core/repos.ts";
import { NO_VISION, parseVision } from "../../../core/vision.ts";
import { blobForRender } from "../../../git/read.ts";
import { runGit } from "../../../git/env.ts";
import { repoDir } from "../../../git/repos.ts";
import { good, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "vision",
  doc: "`{ repo }`: `{ purpose, order: [{ n, name, text }], rules, direction, updatedAt }` from docs/VISION.md on the default branch; without the document `purpose` is null and `order` empty; `direction` (the autonomy direction) only for those who may read the repository's settings, else null",
  description:
    "VISION.md: purpose, order, rules.",
  inputSchema: {
    type: "object",
    properties: { repo: REPO_ARG },
    required: ["repo"],
  },
  writes: false,
  async run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const dir = repoDir(ctx.app.reposRoot, repo.ownerName, repo.name);
    const blob = await blobForRender(dir, repo.defaultBranch, "docs/VISION.md", 1_000_000);
    const found = blob.kind === "text";
    const vision = found ? parseVision(new TextDecoder().decode(blob.body)) : NO_VISION;
    const last = found
      ? await runGit(["log", "-1", "--format=%cI", repo.defaultBranch, "--", "docs/VISION.md"], { cwd: dir })
      : undefined;
    return good({
      ...vision,
      direction: canAdmin(ctx.app.db, repo, user) ? repo.autonomyDirection : null,
      updatedAt: last?.ok && last.value.trim() ? last.value.trim() : null,
    });
  },
};
