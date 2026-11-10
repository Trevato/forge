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
import { isFolderName } from "./template_folders.ts";
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
  | "template_unsupported"
  | "template_invalid";

/** Error code → the words a person is shown. */
export const TEMPLATE_ERRORS: Record<TemplateError, string> = {
  no_such_template: "No template by that name that you can read. Name it owner/name.",
  template_empty: "That template has no files yet.",
  template_unreadable: "That template could not be read. Try again.",
  template_too_big: `That template is over the cap (${TEMPLATE_MAX_FILES} files, ${TEMPLATE_MAX_FILE_BYTES / 1024} KiB a file, ${TEMPLATE_MAX_BYTES / 1024 / 1024} MiB in all).`,
  template_has_symlink: "That template holds a symbolic link, which is not copied.",
  template_unsupported: "That template holds something that is not a plain file.",
  template_invalid: "That template's template.json is not valid, or names something outside its folder.",
};

/** `owner/name` or `owner/name/folder`, each part plain; anything else is not a template name. */
export function parseTemplateName(text: string): { owner: string; name: string; folder?: string } | undefined {
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})(?:\/([^/]+))?$/.exec(text.trim());
  if (!m) return undefined;
  if (m[3] !== undefined && !isFolderName(m[3])) return undefined;
  return { owner: m[1]!, name: m[2]!, ...(m[3] === undefined ? {} : { folder: m[3] }) };
}

/** The literals a template.json may name, and what each is filled with. */
export interface TemplateFill {
  name: string;
  description: string;
}
const LITERALS = ["{{name}}", "{{description}}"] as const;

/**
 * Read a folder's template.json: `{ "files": ["README.md"], "literals": ["{{name}}"] }`.
 * Each named file must be a file the folder holds (no `..`, no leading `/`),
 * each literal one of `LITERALS`. Returns the filled files, or undefined when invalid.
 */
function fillLiterals(files: FileWrite[], fill: TemplateFill): FileWrite[] | undefined {
  const config = files.find((f) => f.path === "template.json");
  if (!config || !(config.content instanceof Uint8Array)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(config.content));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const { files: named = [], literals = [] } = parsed as { files?: unknown; literals?: unknown };
  if (!Array.isArray(named) || !Array.isArray(literals)) return undefined;
  const paths = new Set<string>();
  for (const p of named) {
    if (typeof p !== "string" || !isSafeTreePath(p) || !files.some((f) => f.path === p)) return undefined;
    paths.add(p);
  }
  const values: Record<string, string> = { "{{name}}": fill.name, "{{description}}": fill.description };
  for (const l of literals) if (typeof l !== "string" || !(LITERALS as readonly string[]).includes(l)) return undefined;
  return files.map((f) => {
    if (!paths.has(f.path) || !(f.content instanceof Uint8Array)) return f;
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(f.content);
    } catch {
      return f;
    }
    for (const l of literals as string[]) text = text.split(l).join(values[l]!);
    return { ...f, content: new TextEncoder().encode(text) };
  });
}

export async function templateFiles(
  app: App,
  actor: User | undefined,
  named: string,
  fill: TemplateFill = { name: "", description: "" },
): Promise<Result<FileWrite[], TemplateError>> {
  const parsed = parseTemplateName(named);
  if (!parsed) return err("no_such_template");
  const repo = getRepo(app.db, parsed.owner, parsed.name);
  if (!repo || !canRead(app.db, repo, actor)) return err("no_such_template");
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const rev = `refs/heads/${repo.defaultBranch}`;
  const prefix = parsed.folder === undefined ? "" : `${parsed.folder}/`;
  const listed = await runGitRaw(["ls-tree", "-r", "-z", "-l", rev, ...(prefix === "" ? [] : ["--", prefix])], {
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
    const full = record.slice(tab + 1);
    if (!full.startsWith(prefix)) continue;
    const path = full.slice(prefix.length);
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
  if (entries.length === 0) return err(parsed.folder === undefined ? "template_empty" : "no_such_template");

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
  if (parsed.folder === undefined) return ok(files);
  // A folder is a template only with both marker files; its literals are filled here, nothing is run.
  if (!files.some((f) => f.path === "TEMPLATE.md") || !files.some((f) => f.path === "template.json"))
    return err("no_such_template");
  const filled = fillLiterals(files, fill);
  return filled ? ok(filled) : err("template_invalid");
}
