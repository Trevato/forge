/**
 * A person's dotfiles in every shell they open (#10548): they name one
 * repository on this forge that they can read, and a new shell copies its
 * top-level dotfiles into the cell's home after the forge's own rc is
 * written, so the forge's defaults come first and theirs win.
 *
 * Nothing is run here. Files are copied as plain data: only regular files
 * (never symlinks or directories), only names that are a dot and a short
 * safe word, never `.git` or the forge's own `.forge_*`, each under a size
 * ceiling and at most `MAX_FILES` of them. The forge's rc sources `.bashrc`
 * itself, which is the one dotfile the shell evaluates; the others (a
 * `.gitconfig`, a `.tmux.conf`) are read by the tool they belong to.
 *
 * A repository that is missing, or that the person cannot read, is not an
 * error for the shell: it opens, and its greeting names the repository once.
 * The repository is read as the person at open time, so a repository they
 * lose access to stops being copied; files an earlier session copied are
 * removed first (a manifest in the home lists them), so a changed or emptied
 * setting does not leave the old ones behind.
 */
import { lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { App } from "../app.ts";
import { canRead, getRepo } from "../core/repos.ts";
import { getUserSetting, setUserSetting } from "../core/settings.ts";
import type { User } from "../core/users.ts";
import { blobForRender, listTree } from "../git/read.ts";
import { repoDir } from "../git/repos.ts";
import { isSafeName } from "../git/guard.ts";
import { resolveOid } from "../git/merge.ts";
import { err, ok, type Result } from "../kernel/result.ts";

const KEY = "dotfiles_repo";
export const MAX_FILES = 32;
export const MAX_FILE_BYTES = 64 * 1024;
export const MANIFEST_FILE = ".forge_dotfiles";
const DOTFILE = /^\.[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type DotfilesError = "invalid" | "not_found";

export const DOTFILES_ERRORS: Record<DotfilesError, string> = {
  invalid: "Name a repository as owner/name, or leave this empty for none.",
  not_found: "No repository by that name that you can read.",
};

/** `owner/name` from text, "" for none; anything else is refused. */
export function parseDotfilesRepo(text: string): Result<string, "invalid"> {
  const t = text.trim();
  if (t === "") return ok("");
  if (t.length > 120) return err("invalid");
  const parts = t.split("/");
  if (parts.length !== 2) return err("invalid");
  const [owner, name] = parts as [string, string];
  return isSafeName(owner) && isSafeName(name) ? ok(`${owner}/${name}`) : err("invalid");
}

/** The repository a person named, or undefined for none. */
export function dotfilesRepoOf(db: Database, userId: string): string | undefined {
  const v = getUserSetting(db, userId, KEY);
  return v === undefined || v === "" ? undefined : v;
}

/** Save the person's choice; a repository they cannot read is refused here too. */
export function setDotfilesRepo(db: Database, user: User, text: string): Result<"set" | "cleared", DotfilesError> {
  const parsed = parseDotfilesRepo(text);
  if (!parsed.ok) return err("invalid");
  if (parsed.value === "") {
    setUserSetting(db, user.id, KEY, "");
    return ok("cleared");
  }
  const [owner, name] = parsed.value.split("/") as [string, string];
  const repo = getRepo(db, owner, name);
  if (repo === undefined || !canRead(db, repo, user)) return err("not_found");
  setUserSetting(db, user.id, KEY, parsed.value);
  return ok("set");
}

export interface DotFile {
  readonly name: string;
  readonly body: Uint8Array;
}

export interface DotfileSet {
  readonly files: readonly DotFile[];
  /** The repository that could not be read, named for the greeting; null when nothing is wrong. */
  readonly unreadable: string | null;
}

export const NO_DOTFILES: DotfileSet = { files: [], unreadable: null };

/** Whether a top-level name is one the shell may be given. */
export function isCopyable(name: string): boolean {
  return DOTFILE.test(name) && name !== ".git" && !name.startsWith(".forge_");
}

/** Read the named repository's dotfiles as `user`; never throws. */
export async function loadDotfiles(app: App, user: User): Promise<DotfileSet> {
  const named = dotfilesRepoOf(app.db, user.id);
  if (named === undefined) return NO_DOTFILES;
  const refused: DotfileSet = { files: [], unreadable: named };
  try {
    const parsed = parseDotfilesRepo(named);
    if (!parsed.ok || parsed.value === "") return refused;
    const [owner, name] = parsed.value.split("/") as [string, string];
    const repo = getRepo(app.db, owner, name);
    if (repo === undefined || !canRead(app.db, repo, user)) return refused;
    const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
    const tip = await resolveOid(dir, `refs/heads/${repo.defaultBranch}`);
    if (tip === undefined) return { files: [], unreadable: null };
    const tree = await listTree(dir, tip, "");
    if (!tree.ok) return refused;
    const files: DotFile[] = [];
    for (const e of tree.value) {
      if (files.length >= MAX_FILES) break;
      if (e.type !== "blob" || (e.mode !== "100644" && e.mode !== "100755")) continue;
      if (!isCopyable(e.name) || e.size > MAX_FILE_BYTES) continue;
      const blob = await blobForRender(dir, tip, e.name, MAX_FILE_BYTES);
      if (blob.kind === "text" || blob.kind === "binary") files.push({ name: e.name, body: blob.body });
    }
    return { files, unreadable: null };
  } catch {
    return refused;
  }
}

/**
 * Write a file the person's home may already hold something at: the old entry
 * is removed first (a symlink goes, never its target) and the new file is
 * created exclusively, so a link planted between the two is refused too.
 */
export function writeFresh(path: string, data: string | Uint8Array, mode = 0o644): void {
  rmSync(path, { force: true });
  writeFileSync(path, data, { mode, flag: "wx" });
}

/** Copy the set into `home`, replacing what the last session copied. */
export function applyDotfiles(home: string, set: DotfileSet): void {
  const manifest = join(home, MANIFEST_FILE);
  if (lstatSync(manifest, { throwIfNoEntry: false })?.isFile()) {
    for (const name of readFileSync(manifest, "utf8").split("\n"))
      if (isCopyable(name)) rmSync(join(home, name), { force: true });
  }
  for (const f of set.files) writeFresh(join(home, f.name), f.body);
  writeFresh(manifest, set.files.map((f) => f.name).join("\n"));
}
