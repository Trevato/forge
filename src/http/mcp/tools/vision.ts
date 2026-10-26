import { getPull } from "../../../core/pulls.ts";
import { directionParts, previewVision } from "../../../crew/vision.ts";
import { canAdmin } from "../../../core/repos.ts";
import { NO_VISION, parseVision } from "../../../core/vision.ts";
import { blobForRender } from "../../../git/read.ts";
import { runGit } from "../../../git/env.ts";
import { repoDir } from "../../../git/repos.ts";
import { good, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "vision",
  doc: "`{ repo, number? }`: `{ purpose, order: [{ n, name, text }], rules, direction, directionParts, preview, updatedAt }` from docs/VISION.md on the default branch; without the document `purpose` is null and `order` empty; `direction` (the autonomy direction) and `directionParts` (it cut into `{ kind: vision|owner, text }`: the fenced block that follows docs/VISION.md, and the owner's words) only for those who may read the repository's settings, else null; with `number` (an open vision pull) those same people get `preview`: `{ today, after }`, the direction as it stands and as an admin's merge will write it, or `{ why }` it would stay; else null",
  description:
    "VISION.md: purpose, order, rules.",
  inputSchema: {
    type: "object",
    properties: { repo: REPO_ARG, number: { type: "integer", minimum: 1 } },
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
    const admin = canAdmin(ctx.app.db, repo, user);
    const n = args["number"];
    const pull = admin && typeof n === "number" && Number.isInteger(n) && n > 0 ? getPull(ctx.app.db, repo.id, n) : undefined;
    const shown = pull ? await previewVision(ctx.app, repo, pull) : null;
    return good({
      ...vision,
      direction: admin ? repo.autonomyDirection : null,
      directionParts: admin ? directionParts(repo.autonomyDirection) : null,
      preview: shown === null ? null : shown.ok ? { today: shown.today, after: shown.after } : { why: shown.why },
      updatedAt: last?.ok && last.value.trim() ? last.value.trim() : null,
    });
  },
};
