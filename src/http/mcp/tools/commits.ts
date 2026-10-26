import { commitLog } from "../../../git/read.ts";
import { diffCommit } from "../../../git/diff.ts";
import { repoDir } from "../../../git/repos.ts";
import { isSafeRef } from "../../../git/guard.ts";
import { checkOfCommit } from "../../../actions/runs.ts";
import { good, bad, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "commits",
  doc: "`{ repo, ref?, limit?, oid? }`: a branch's recent commits, newest first (`limit` 1–100, default 30; refused outside that, where REST clamps), as `GET …/commits` answers; with `oid` (4–64 hex) one commit with its diff and its check, as `GET …/commits/{oid}` and `…/check` answer",
  description:
    "Recent commits; `oid`: one commit, diff and check.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      ref: { type: "string", maxLength: 255 },
      limit: { type: "integer", minimum: 1, maximum: 100 },
      oid: { type: "string", minLength: 4, maxLength: 64, },
    },
    required: ["repo"],
  },
  writes: false,
  async run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const oid = args["oid"];
    if (oid !== undefined) {
      if (typeof oid !== "string" || !/^[0-9a-fA-F]{4,64}$/.test(oid))
        return bad("invalid", "`oid` is 4 to 64 hex digits");
      const dir = repoDir(ctx.app.reposRoot, repo.ownerName, repo.name);
      const log = await commitLog(dir, oid, { limit: 1 });
      const commit = log.ok ? log.value[0] : undefined;
      if (!commit) return bad("not_found", "no such commit");
      const diff = await diffCommit(dir, commit.oid);
      const check = await checkOfCommit(ctx.app, user, repo, commit.oid);
      const files = diff.ok ? diff.value : { files: [], additions: 0, deletions: 0 };
      return good({
        says: `${commit.oid.slice(0, 7)} ${commit.subject}: ${files.files.length} file(s) changed.`,
        ...commit,
        diff: files,
        check: check.ok ? check.value : null,
      });
    }
    const ref = args["ref"] ?? repo.defaultBranch;
    if (typeof ref !== "string" || ref.length > 255 || !isSafeRef(ref))
      return bad("invalid", "`ref` is a branch, tag or commit");
    const limit = args["limit"] ?? 30;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100)
      return bad("invalid", "`limit` is a whole number from 1 to 100");
    const log = await commitLog(repoDir(ctx.app.reposRoot, repo.ownerName, repo.name), ref, { limit });
    return good({ commits: log.ok ? log.value : [] });
  },
};
