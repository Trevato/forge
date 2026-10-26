import { repoDir } from "../../../git/repos.ts";
import { runGit } from "../../../git/env.ts";
import { isSafeRef, isSafeTreePath } from "../../../git/guard.ts";
import { blobForRender, listTree } from "../../../git/read.ts";
import { good, bad, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "read_file",
  doc: "a file (utf-8, or base64 for binary) or a directory listing at a ref, as GET …/contents",
  description:
    "Read a file or list a directory at a ref (default branch); over 5 MB answers tooLarge.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      path: { type: "string", maxLength: 1024 },
      ref: { type: "string", maxLength: 256 },
    },
    required: ["repo", "path"],
  },
  writes: false,
  async run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const rawRef = args["ref"];
    const rawPath = args["path"];
    if (
      (rawRef !== undefined && typeof rawRef !== "string") ||
      typeof rawPath !== "string"
    )
      return bad("invalid", "path and ref are strings");
    const ref = rawRef || repo.defaultBranch;
    if (!isSafeRef(ref) || (rawPath !== "" && !isSafeTreePath(rawPath)))
      return bad("not_found", "no such path at that ref");
    const dir = repoDir(ctx.app.reposRoot, repo.ownerName, repo.name);
    const spec = rawPath === "" ? ref : `${ref}:${rawPath}`;
    const type = await runGit(["cat-file", "-t", spec], { cwd: dir });
    if (rawPath === "" || (type.ok && type.value === "tree")) {
      const tree = await listTree(dir, ref, rawPath);
      if (!tree.ok) return bad("not_found", "no such path at that ref");
      return good({ type: "dir", ref, path: rawPath, entries: tree.value });
    }
    const blob = await blobForRender(dir, ref, rawPath, 5_000_000);
    if (blob.kind === "missing") return bad("not_found", "no such path at that ref");
    if (blob.kind === "too_large")
      return good({ type: "file", tooLarge: true, size: blob.size });
    const binary = blob.kind === "binary";
    return good({
      type: "file",
      ref,
      path: rawPath,
      size: blob.size,
      encoding: binary ? "base64" : "utf-8",
      content: binary
        ? Buffer.from(blob.body).toString("base64")
        : new TextDecoder().decode(blob.body),
    });
  },
};
