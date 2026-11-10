/**
 * A template repository's tip, read as the files a new app starts with.
 * Three refusals keep the copy safe: the caller must be able to read the
 * template (anything else answers `no_such_template`, so a private name is
 * never confirmed), the tip must fit the caps, and it holds no symlink or
 * submodule, which would point outside the new repository.
 */

import { canRead, getRepo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import type { App } from "../app.ts";
import { OVER_CAP, runGitRaw } from "../git/env.ts";
import { isSafeTreePath } from "../git/guard.ts";
import { repoDir } from "../git/repos.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import type { FileWrite } from "../git/write.ts";

/** Most files a template may hold. */
export const TEMPLATE_MAX_FILES = 500;
/** Most bytes one template file may hold. */
export const TEMPLATE_MAX_FILE_BYTES = 512 * 1024;
/** Most bytes the whole template may hold. */
export const TEMPLATE_MAX_BYTES = 4 * 1024 * 1024;

/** Most bytes `ls-tree` may print: a path and its numbers fit in 1 KiB. */
const TEMPLATE_MAX_LIST_BYTES = (TEMPLATE_MAX_FILES + 1) * 1024;

export type TemplateError =
  | "no_such_template"
  | "template_empty"
  | "template_unreadable"
  | "template_too_big"
  | "template_has_symlink"
  | "template_unsupported";

/** Error code → the words a person is shown. */
export const TEMPLATE_ERRORS: Record<TemplateError, string> = {
  no_such_template: "No template by that name that you can read. Name it owner/name.",
  template_empty: "That template has no files yet.",
  template_unreadable: "That template could not be read. Try again.",
  template_too_big: `That template is over the cap (${TEMPLATE_MAX_FILES} files, ${TEMPLATE_MAX_FILE_BYTES / 1024} KiB a file, ${TEMPLATE_MAX_BYTES / 1024 / 1024} MiB in all).`,
  template_has_symlink: "That template holds a symbolic link, which is not copied.",
  template_unsupported: "That template holds something that is not a plain file.",
};

/** `owner/name`, each part plain; anything else is not a template name. */
export function parseTemplateName(text: string): { owner: string; name: string } | undefined {
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})$/.exec(text.trim());
  return m ? { owner: m[1]!, name: m[2]! } : undefined;
}

export async function templateFiles(
  app: App,
  actor: User | undefined,
  named: string,
): Promise<Result<FileWrite[], TemplateError>> {
  const parsed = parseTemplateName(named);
  if (!parsed) return err("no_such_template");
  const repo = getRepo(app.db, parsed.owner, parsed.name);
  if (!repo || !canRead(app.db, repo, actor)) return err("no_such_template");
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const rev = `refs/heads/${repo.defaultBranch}`;
  const listed = await runGitRaw(["ls-tree", "-r", "-z", "-l", rev], {
    cwd: dir,
    timeoutMs: 20_000,
    maxBytes: TEMPLATE_MAX_LIST_BYTES,
  });
  if (!listed.ok) return err(listed.error.code === OVER_CAP ? "template_too_big" : "template_empty");

  const entries: { mode: string; oid: string; size: number; path: string }[] = [];
  let total = 0;
  for (const record of new TextDecoder().decode(listed.value).split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const [mode = "", , oid = "", size = "0"] = record.slice(0, tab).split(/ +/);
    const path = record.slice(tab + 1);
    if (mode === "120000") return err("template_has_symlink");
    if (mode !== "100644" && mode !== "100755") return err("template_unsupported");
    if (!isSafeTreePath(path)) return err("template_unsupported");
    const bytes = Number(size);
    total += bytes;
    if (
      entries.length + 1 > TEMPLATE_MAX_FILES ||
      bytes > TEMPLATE_MAX_FILE_BYTES ||
      total > TEMPLATE_MAX_BYTES
    )
      return err("template_too_big");
    entries.push({ mode, oid, size: bytes, path });
  }
  if (entries.length === 0) return err("template_empty");

  // One process reads every blob: `<oid> <type> <size>\n<body>\n` per entry.
  const raw = await runGitRaw(["cat-file", "--batch"], {
    cwd: dir,
    stdin: entries.map((e) => `${e.oid}\n`).join(""),
    timeoutMs: 30_000,
    maxBytes: TEMPLATE_MAX_BYTES + entries.length * 128,
  });
  if (!raw.ok) return err("template_unreadable");
  const bytes = raw.value;
  const decoder = new TextDecoder();
  const files: FileWrite[] = [];
  let at = 0;
  for (const e of entries) {
    const nl = bytes.indexOf(10, at);
    if (nl < 0) return err("template_unreadable");
    const header = decoder.decode(bytes.subarray(at, nl)).split(" ");
    const size = Number(header[2]);
    if (header[1] !== "blob" || size !== e.size || nl + 1 + size > bytes.length) return err("template_unreadable");
    files.push({ path: e.path, content: bytes.slice(nl + 1, nl + 1 + size), mode: e.mode as "100644" | "100755" });
    at = nl + 1 + size + 1;
  }
  return ok(files);
}
