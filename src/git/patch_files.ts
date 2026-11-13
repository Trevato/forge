/**
 * A unified diff turned into the files it produces, without a work tree.
 *
 * The patch is applied to a scratch index read from `base` (`git apply
 * --cached`, the patch on stdin, never in an argument), and the difference
 * between that index and `base` is read back as whole files. Those files go
 * through the ordinary edit path (`actions/contents.ts`), which owns the
 * limits, the commit and its author, so a patch gets no door a file edit
 * does not have. Text only: a binary patch, a symlink, a submodule or a path
 * that is not a safe tree path is refused. Modes other than the plain file
 * are dropped (an executable bit does not travel in a patch here).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { err, ok, type Result } from "../kernel/result.ts";
import { runGit, runGitRaw } from "./env.ts";
import { isSafeTreePath } from "./guard.ts";
import type { FileWrite } from "./write.ts";

/** The most patch bytes one call takes. */
export const MAX_PATCH_BYTES = 256 * 1024;

export type PatchError =
  | "too_large"
  | "empty"
  | "does_not_apply"
  | "unsupported"
  | "bad_path";

/** `dir` is a bare repository, `base` a commit in it, `scratch` a directory the caller may write. */
export async function patchToFiles(
  dir: string,
  base: string,
  patch: string,
  scratch: string,
): Promise<Result<FileWrite[], PatchError>> {
  if (Buffer.byteLength(patch, "utf8") > MAX_PATCH_BYTES) return err("too_large");
  if (patch.trim() === "") return err("empty");
  if (patch.includes("\0")) return err("unsupported");
  const work = await mkdtemp(join(scratch, "patch-"));
  const env = { GIT_INDEX_FILE: join(work, "index") };
  try {
    const read = await runGit(["read-tree", base], { cwd: dir, env });
    if (!read.ok) return err("does_not_apply");
    const text = patch.endsWith("\n") ? patch : `${patch}\n`;
    const applied = await runGit(["apply", "--cached", "--whitespace=nowarn", "-"], { cwd: dir, env, stdin: text });
    if (!applied.ok) return err(/binary/i.test(applied.error.stderr) ? "unsupported" : "does_not_apply");
    const raw = await runGitRaw(["diff", "--cached", "--raw", "-z", "--no-renames", "--no-abbrev", base], { cwd: dir, env });
    if (!raw.ok) return err("does_not_apply");
    const fields = new TextDecoder().decode(raw.value).split("\0");
    const files: FileWrite[] = [];
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const meta = (fields[i] ?? "").split(" ");
      const path = fields[i + 1] ?? "";
      const [, newMode, , newOid, status] = meta;
      if (!isSafeTreePath(path)) return err("bad_path");
      if (status === "D") {
        files.push({ path, content: null });
        continue;
      }
      if (newMode !== "100644" && newMode !== "100755") return err("unsupported");
      const blob = await runGitRaw(["cat-file", "blob", newOid ?? ""], { cwd: dir, env });
      if (!blob.ok) return err("does_not_apply");
      try {
        files.push({ path, content: new TextDecoder("utf-8", { fatal: true }).decode(blob.value) });
      } catch {
        return err("unsupported");
      }
    }
    return files.length === 0 ? err("empty") : ok(files);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
