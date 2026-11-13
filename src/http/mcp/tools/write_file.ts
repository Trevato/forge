import { repoDir } from "../../../git/repos.ts";
import { runGit } from "../../../git/env.ts";
import { isSafeRef } from "../../../git/guard.ts";
import { editMessage } from "../../../actions/edit_words.ts";
import { commitToBranch } from "../../../actions/repos.ts";
import { good, bad, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "write_file",
  doc: "`{ repo, branch, path, content, message }`: commit one file to an existing branch as `POST …/contents` does, for the same callers and with the same refusals (protected default, too large, a path with `..`), said in `edit_words`' sentences; answers `{ commit, says }`",
  description: "No shell? Commit one file to a branch. With a shell, clone and push.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      branch: { type: "string" },
      path: { type: "string" },
      content: { type: "string" },
      message: { type: "string" },
    },
    required: ["repo", "branch", "path", "content", "message"],
  },
  writes: true,
  async run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const { branch, path, content, message } = args;
    if (
      typeof branch !== "string" ||
      typeof path !== "string" ||
      typeof content !== "string" ||
      typeof message !== "string"
    )
      return bad("invalid", "branch, path, content and message are strings");
    if (!isSafeRef(branch)) return bad("not_found", "no such branch");
    const dir = repoDir(ctx.app.reposRoot, repo.ownerName, repo.name);
    const there = await runGit(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: dir });
    if (!there.ok) return bad("not_found", "no such branch");
    // The head read here is the one the commit must follow: a branch
    // deleted or moved since is refused as branch_moved, not recreated.
    const committed = await commitToBranch(ctx.app, user, repo, {
      branch,
      message,
      files: [{ path, content }],
      expectTip: there.value,
    });
    if (!committed.ok) {
      const e = committed.error;
      if (typeof e === "string")
        return bad(e, e === "not_found" ? "no such repository" : "this is not yours to write");
      return bad(e.kind, editMessage(e.kind));
    }
    return good({ says: `Committed ${path} to ${branch}.`, commit: committed.value.commitOid });
  },
};
