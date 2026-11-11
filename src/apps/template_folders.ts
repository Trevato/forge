/**
 * A template repository whose top-level folders each hold `TEMPLATE.md` and
 * `template.json` offers each such folder as a template of its own, in place
 * of the repository. A folder missing either file is not offered. The forge
 * only reads files here; it never runs anything a template holds.
 *
 * A choice is named `owner/name/folder`. `TEMPLATE.md` gives the title (its
 * first line, `#` marks dropped) and the line under it; both are plain text
 * here and escaped where they are shown.
 */

import type { App } from "../app.ts";
import { offeredTemplates } from "../core/app_templates.ts";
import { getRepo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { runGitRaw } from "../git/env.ts";
import { repoDir } from "../git/repos.ts";

/** Most folders one repository offers. */
export const TEMPLATE_MAX_FOLDERS = 50;
/** Most bytes read from the tree listing and from all the TEMPLATE.md files. */
const LIST_MAX_BYTES = 1024 * 1024;
const NOTE_MAX_BYTES = 512 * 1024;

/** A folder name that can be named in `owner/name/folder`. */
export function isFolderName(text: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(text) && !text.includes("..");
}

export interface TemplateChoice {
  /** What the picker submits: `owner/name`, or `owner/name/folder`. */
  value: string;
  title: string;
  /** The line under the title; empty for a whole repository. */
  line: string;
}

/** Title and first line from a TEMPLATE.md. */
export function describeTemplate(markdown: string, fallback: string): { title: string; line: string } {
  const lines = markdown.split(/\r?\n/).map((l) => l.trim());
  const at = lines.findIndex((l) => l !== "");
  if (at === -1) return { title: fallback, line: "" };
  const title = lines[at]!.replace(/^#+\s*/, "").slice(0, 80) || fallback;
  const line = (lines.slice(at + 1).find((l) => l !== "") ?? "").replace(/^#+\s*/, "").slice(0, 200);
  return { title, line };
}

/** The folders of `ownerName/name` that are templates, in tree order. Empty when none or unreadable. */
export async function templateFolders(
  app: App,
  repo: { ownerName: string; name: string; defaultBranch: string },
): Promise<{ folder: string; title: string; line: string }[]> {
  const cwd = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const rev = `refs/heads/${repo.defaultBranch}`;
  const listed = await runGitRaw(["ls-tree", "-r", "-z", rev], { cwd, timeoutMs: 10_000, maxBytes: LIST_MAX_BYTES });
  if (!listed.ok) return [];
  const notes = new Map<string, string>(); // folder → TEMPLATE.md oid
  const configs = new Set<string>();
  for (const record of new TextDecoder().decode(listed.value).split("\0")) {
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const [mode = "", type = "", oid = ""] = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    const parts = path.split("/");
    if (parts.length !== 2 || type !== "blob" || (mode !== "100644" && mode !== "100755")) continue;
    if (!isFolderName(parts[0]!)) continue;
    if (parts[1] === "TEMPLATE.md") notes.set(parts[0]!, oid);
    else if (parts[1] === "template.json") configs.add(parts[0]!);
  }
  const folders = [...notes.keys()].filter((f) => configs.has(f)).slice(0, TEMPLATE_MAX_FOLDERS);
  if (folders.length === 0) return [];
  const raw = await runGitRaw(["cat-file", "--batch"], {
    cwd,
    stdin: folders.map((f) => `${notes.get(f)}\n`).join(""),
    timeoutMs: 10_000,
    maxBytes: NOTE_MAX_BYTES,
  });
  if (!raw.ok) return [];
  const bytes = raw.value;
  const decoder = new TextDecoder();
  const out: { folder: string; title: string; line: string }[] = [];
  let at = 0;
  for (const folder of folders) {
    const nl = bytes.indexOf(10, at);
    if (nl < 0) return [];
    const header = decoder.decode(bytes.subarray(at, nl)).split(" ");
    const size = Number(header[2]);
    if (header[1] !== "blob" || !Number.isFinite(size) || nl + 1 + size > bytes.length) return [];
    out.push({ folder, ...describeTemplate(decoder.decode(bytes.subarray(nl + 1, nl + 1 + size)), folder) });
    at = nl + 1 + size + 1;
  }
  return out;
}

/**
 * What New app offers `actor`: each marked, readable repository, or its
 * template folders in its place when it has any.
 */
export async function templateChoices(app: App, actor: User | undefined): Promise<TemplateChoice[]> {
  // Repositories are read side by side: each read is two git processes.
  const perRepo = await Promise.all(
    offeredTemplates(app.db, actor).map(async (name) => {
      const [owner = "", repoName = ""] = name.split("/");
      const repo = getRepo(app.db, owner, repoName);
      const folders = repo ? await templateFolders(app, repo) : [];
      if (folders.length === 0) return [{ value: name, title: name, line: "" }];
      return folders.map((f) => ({ value: `${name}/${f.folder}`, title: f.title, line: f.line }));
    }),
  );
  return perRepo.flat();
}
