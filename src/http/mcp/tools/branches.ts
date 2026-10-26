import { createBranch, deleteBranch } from "../../../actions/branches.ts";
import { listBranches } from "../../../git/branches.ts";
import { listRefs } from "../../../git/read.ts";
import { repoDir } from "../../../git/repos.ts";
import { runGit } from "../../../git/env.ts";
import { CREATE_ERRORS, DELETE_ERRORS } from "../../../web/pages/branches.ts";
import { BRANCH_NOT_CREATED, BRANCH_NOT_DELETED } from "../../../actions/branch_words.ts";
import { good, bad, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "branches",
  doc: "`{ repo, name?, action?, from?, kind? }`: without `name`, lists the branches; `kind: \"tags\"` lists the tags instead (as GET `/api/v1/repos/:owner/:name/tags` does, newest first; no `name` or `action`); with `name` and `action` (`create` from `from`, or `delete`) it does what the branches page does: the default branch is never deleted, only a writer may act",
  description:
    "A repo's branches; `name`, `action` create (from `from`) or delete one, not the default.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      name: { type: "string", maxLength: 255 },
      action: { type: "string", enum: ["create", "delete"] },
      from: { type: "string", maxLength: 255 },
      kind: { type: "string", enum: ["branches", "tags"], description: "tags: newest first" },
    },
    required: ["repo"],
  },
  writes: true,
  readsWithout: "name",
  async run(ctx, user, args) {
    const kind = args["kind"] ?? "branches";
    if (kind !== "branches" && kind !== "tags") return bad("invalid", "`kind` is branches or tags");
    if (kind === "tags" && (args["name"] !== undefined || args["action"] !== undefined))
      return bad("invalid", "`kind: tags` only lists; leave out `name` and `action`");
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    if (kind === "tags") {
      const dir = repoDir(ctx.app.reposRoot, repo.ownerName, repo.name);
      const refs = await listRefs(dir, "refs/tags/");
      if (!refs.ok) return good({ tags: [] });
      const order = await runGit(
        ["for-each-ref", "--sort=-creatordate", "--format=%(refname)", "--", "refs/tags/"],
        { cwd: dir },
      );
      const rank = new Map((order.ok ? order.value.split("\n") : []).map((n, i) => [n, i]));
      refs.value.sort((a, b) => (rank.get(a.name) ?? 0) - (rank.get(b.name) ?? 0));
      return good({
        tags: refs.value.map((r) => ({
          name: r.name.replace("refs/tags/", ""),
          oid: r.oid,
          commit: r.peeled ?? r.oid,
        })),
      });
    }
    const base = `/${repo.ownerName}/${repo.name}/branches`;
    if (args["name"] === undefined) {
      const listed = await listBranches(
        repoDir(ctx.app.reposRoot, repo.ownerName, repo.name),
        repo.defaultBranch,
      );
      return good({
        branches: listed.ok
          ? listed.value.branches.map((b) => ({ name: b.name, default: b.isDefault, ahead: b.ahead, behind: b.behind }))
          : [],
        url: base,
      });
    }
    const name = args["name"];
    const action = args["action"];
    const from = args["from"];
    if (typeof name !== "string" || name.length > 255)
      return bad("invalid", "`name` is a branch name");
    if (action !== "create" && action !== "delete")
      return bad("invalid", "`action` is create or delete");
    if (from !== undefined && (typeof from !== "string" || from.length > 255))
      return bad("invalid", "`from` is a branch, tag or commit");
    if (action === "create") {
      const made = await createBranch(ctx.app, user, repo, {
        name,
        ...(from === undefined || from === "" ? {} : { from }),
      });
      if (!made.ok)
        return bad(made.error, CREATE_ERRORS[made.error] ?? BRANCH_NOT_CREATED);
      return good({ says: `Created ${made.value.name} at ${made.value.oid.slice(0, 7)}.`, url: base });
    }
    const gone = await deleteBranch(ctx.app, user, repo, name);
    if (!gone.ok)
      return bad(gone.error, DELETE_ERRORS[gone.error] ?? BRANCH_NOT_DELETED);
    return good({ says: `Deleted ${gone.value.name}.`, url: base });
  },
};
