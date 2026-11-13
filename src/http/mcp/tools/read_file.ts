import { repoDir } from "../../../git/repos.ts";
import { runGit } from "../../../git/env.ts";
import { isSafeRef, isSafeTreePath } from "../../../git/guard.ts";
import { blobForRender, listTree } from "../../../git/read.ts";
import { readStl, sayStl, stlSize, TOO_LARGE } from "../../../text/stl.ts";
import { checkConfig, configKind, type ConfigKind } from "../../../text/config_check.ts";
import { describeMedia } from "../../../text/mp4.ts";
import { good, bad, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "read_file",
  doc: "`{ repo, path, ref? }`: a file (utf-8, or base64 for binary) or a directory listing at a ref, as GET …/contents; MP4/MOV/M4A files also carry about: {kind, seconds, width?, height?, says}",
  description:
    "No shell? Read a file or list a directory at a ref (default branch); over 5 MB answers tooLarge.",
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
    const content = binary ? "" : new TextDecoder().decode(blob.body);
    const about = aboutFile(rawPath, blob.body, binary ? undefined : content);
    return good({
      type: "file",
      ref,
      path: rawPath,
      size: blob.size,
      encoding: binary ? "base64" : "utf-8",
      content: binary ? Buffer.from(blob.body).toString("base64") : content,
      ...(about ? { about } : {}),
    });
  },
};

/** A file described in words beside its content; one branch per kind. */
function aboutFile(path: string, body: Uint8Array, text: string | undefined): Record<string, unknown> | undefined {
  if (/\.stl$/i.test(path)) {
    const stl = readStl(body);
    if (!stl.ok && stl.error === TOO_LARGE) return { kind: "stl", says: `STL, ${TOO_LARGE}` };
    if (!stl.ok) return { kind: "stl", says: `STL, unreadable: ${stl.error}` };
    const { format, triangles } = stl.value;
    return { kind: "stl", format, triangles, size: stlSize(stl.value), says: sayStl(stl.value) };
  }
  const media = describeMedia(path, body);
  if (media) return media;
  if (text === undefined) return undefined;
  const kind = configKind(path);
  return kind === null ? undefined : aboutConfig(kind, text);
}

function aboutConfig(kind: ConfigKind, content: string) {
  const check = checkConfig(kind, content);
  if (check.ok) return { kind, parses: true };
  return {
    kind,
    parses: false,
    ...(check.line === undefined ? {} : { line: check.line, column: check.column }),
    message: check.message,
  };
}
