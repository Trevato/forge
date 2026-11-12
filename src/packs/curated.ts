/**
 * Curated packs (#11006): a pack is a named, ordered list of repos on this
 * forge, with a pitch and a crew brief, that an admin edits in the forge
 * itself (tables `curated_pack*`). Plain data in, plain data out: every write
 * goes through `editPack`, which checks, saves and keeps who/what/when, so the
 * page, the API and any agent share one rule. Starting a forge reads the list
 * as it stands at that moment; a forge already started keeps its own copy.
 */

import type { Database } from "bun:sqlite";
import { canRead, getRepo, repoDatesFor } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { isSafeName } from "../git/guard.ts";

export const MAX_PACKS = 50;
export const MAX_PACK_REPOS = 20;
const NAME = /^[a-z][a-z0-9-]{0,39}$/;

export interface CuratedPack {
  readonly name: string;
  readonly title: string;
  readonly pitch: string;
  readonly brief: string;
  readonly repos: readonly string[];
}

export interface Change {
  readonly actor: string;
  readonly what: string;
  readonly at: string;
}

type Admin = Pick<User, "id" | "username" | "isAdmin" | "kind">;
export const mayCurate = (u: Admin | undefined): u is Admin => u !== undefined && u.isAdmin && u.kind !== "agent";

export const slugOf = (title: string): string =>
  title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/^[^a-z]+/, "").slice(0, 40).replace(/-+$/, "");

export function listPacks(db: Database): CuratedPack[] {
  const reposOf = new Map<string, string[]>();
  for (const r of db.query<{ pack: string; repo: string }, []>("SELECT pack, repo FROM curated_pack_repo ORDER BY pack, position").all())
    reposOf.set(r.pack, [...(reposOf.get(r.pack) ?? []), r.repo]);
  return db
    .query<{ name: string; title: string; pitch: string; brief: string }, []>(
      "SELECT name, title, pitch, brief FROM curated_pack ORDER BY position, name",
    )
    .all()
    .map((p) => ({ ...p, repos: reposOf.get(p.name) ?? [] }));
}

/** One pack by name: two reads keyed on the name, not every pack. */
export function getPack(db: Database, name: string): CuratedPack | undefined {
  const row = db
    .query<{ name: string; title: string; pitch: string; brief: string }, [string]>("SELECT name, title, pitch, brief FROM curated_pack WHERE name = ?1")
    .get(name);
  if (row === null) return undefined;
  const repos = db.query<{ repo: string }, [string]>("SELECT repo FROM curated_pack_repo WHERE pack = ?1 ORDER BY position").all(name).map((r) => r.repo);
  return { ...row, repos };
}

export function history(db: Database, name: string, limit = 20): Change[] {
  return db
    .query<Change, [string, number]>("SELECT actor, what, at FROM curated_pack_change WHERE pack = ?1 ORDER BY id DESC LIMIT ?2")
    .all(name, limit);
}

/** A repo word as `owner/name`, lowercase, or undefined. */
export function repoWord(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const [owner = "", name = "", ...rest] = v.trim().split("/");
  return rest.length > 0 || !isSafeName(owner) || !isSafeName(name) ? undefined : `${owner}/${name}`.toLowerCase();
}

export type Edit = { title?: unknown; pitch?: unknown; brief?: unknown; repos?: unknown };
export type EditResult = { ok: true; pack: CuratedPack } | { ok: false; error: "forbidden" | "not_found" | "invalid" | "exists"; says: string };

const bad = (says: string): EditResult => ({ ok: false, error: "invalid", says });
const clean = (v: unknown, max: number): string | undefined =>
  typeof v === "string" && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v) ? v.trim() : undefined;

/** What changed between two packs, in one sentence per change. */
function describe(from: CuratedPack | undefined, to: CuratedPack): string[] {
  if (from === undefined) return [`made the pack with ${to.repos.length} repos`];
  const out: string[] = [];
  if (from.title !== to.title) out.push(`renamed it to "${to.title}"`);
  if (from.pitch !== to.pitch) out.push("changed the pitch");
  if (from.brief !== to.brief) out.push("changed the crew brief");
  for (const r of to.repos) if (!from.repos.includes(r)) out.push(`added ${r}`);
  for (const r of from.repos) if (!to.repos.includes(r)) out.push(`removed ${r}`);
  const kept = to.repos.filter((r) => from.repos.includes(r));
  if (kept.join() !== from.repos.filter((r) => to.repos.includes(r)).join()) out.push("reordered the repos");
  return out;
}

/**
 * The one door. Creates the pack when `name` is new (`create`), else changes
 * the fields given; `repos` replaces the list. An admin who is not an agent.
 */
export function editPack(db: Database, user: Admin | undefined, name: string, edit: Edit, create = false): EditResult {
  if (!mayCurate(user)) return { ok: false, error: "forbidden", says: "only a site admin edits packs" };
  if (!NAME.test(name)) return bad("a pack name is lowercase letters, digits and dashes");
  const before = getPack(db, name);
  if (create && before !== undefined) return { ok: false, error: "exists", says: `there is already a pack named ${name}` };
  if (!create && before === undefined) return { ok: false, error: "not_found", says: "no such pack" };
  const title = edit.title === undefined ? (before?.title ?? name) : clean(edit.title, 80);
  const pitch = edit.pitch === undefined ? (before?.pitch ?? "") : clean(edit.pitch, 300);
  const brief = edit.brief === undefined ? (before?.brief ?? "") : clean(edit.brief, 4000);
  if (title === undefined || title === "") return bad("a title is 1 to 80 characters");
  if (pitch === undefined) return bad("a pitch is at most 300 characters");
  if (brief === undefined) return bad("a crew brief is at most 4000 characters");
  let repos: string[] = [...(before?.repos ?? [])];
  if (edit.repos !== undefined) {
    if (!Array.isArray(edit.repos) || edit.repos.length > MAX_PACK_REPOS) return bad(`repos is a list of at most ${MAX_PACK_REPOS} owner/name words`);
    repos = [];
    for (const w of edit.repos) {
      const r = repoWord(w);
      if (r === undefined) return bad("each repo is written owner/name");
      if (!repos.includes(r)) repos.push(r);
    }
  }
  if (before === undefined && (db.query<{ n: number }, []>("SELECT count(*) AS n FROM curated_pack").get()?.n ?? 0) >= MAX_PACKS)
    return bad(`at most ${MAX_PACKS} packs`);
  const after: CuratedPack = { name, title, pitch, brief, repos };
  const said = describe(before, after);
  const at = new Date().toISOString();
  db.transaction(() => {
    if (before === undefined)
      db.query(
        `INSERT INTO curated_pack (name, title, pitch, brief, position, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, (SELECT COALESCE(MAX(position), -1) + 1 FROM curated_pack), ?5, ?5)`,
      ).run(name, title, pitch, brief, at);
    else db.query("UPDATE curated_pack SET title = ?2, pitch = ?3, brief = ?4, updated_at = ?5 WHERE name = ?1").run(name, title, pitch, brief, at);
    db.query("DELETE FROM curated_pack_repo WHERE pack = ?1").run(name);
    for (const [i, r] of repos.entries()) db.query("INSERT INTO curated_pack_repo (pack, repo, position) VALUES (?1, ?2, ?3)").run(name, r, i);
    for (const what of said) db.query("INSERT INTO curated_pack_change (pack, actor, what, at) VALUES (?1, ?2, ?3, ?4)").run(name, user.username, what, at);
  })();
  return { ok: true, pack: after };
}

export type RepoOp = "add" | "remove" | "up" | "down";
export const isRepoOp = (v: unknown): v is RepoOp => v === "add" || v === "remove" || v === "up" || v === "down";

/**
 * One change to a pack's repo list, through `editPack`: the page and the terminal share it.
 * A repo to add must exist here; one to move or remove must be in the pack.
 */
export function changeRepos(db: Database, user: Admin | undefined, name: string, op: unknown, word: unknown): EditResult {
  if (!mayCurate(user)) return { ok: false, error: "forbidden", says: "only a site admin edits packs" };
  const pack = getPack(db, name);
  if (pack === undefined) return { ok: false, error: "not_found", says: "no such pack" };
  const repo = repoWord(word);
  if (repo === undefined) return bad("Write the repo as owner/name.");
  if (!isRepoOp(op)) return bad("Choose add, remove, up or down.");
  const repos = [...pack.repos];
  const at = repos.indexOf(repo);
  if (op === "add") {
    const [owner = "", rname = ""] = repo.split("/");
    if (getRepo(db, owner, rname) === undefined) return bad(`${repo} is not a repository on this forge.`);
    if (at < 0) repos.push(repo);
  } else if (at < 0) return bad(`${repo} is not in this pack.`);
  else if (op === "remove") repos.splice(at, 1);
  else if (op === "up" && at > 0) [repos[at - 1], repos[at]] = [repos[at]!, repos[at - 1]!];
  else if (op === "down" && at < repos.length - 1) [repos[at + 1], repos[at]] = [repos[at]!, repos[at + 1]!];
  return editPack(db, user, name, { repos });
}

export interface PackRepo {
  readonly full: string;
  readonly description: string;
  /** Runs an app on this forge: it has a live link. */
  readonly live: boolean;
  /** The newest push, or null. */
  readonly pushedAt: string | null;
  /** Why it is not shown, when it is not: missing, or not public. */
  readonly left?: string;
}

/** A pack's repos as `viewer` may see them, in the pack's order. Missing and private ones are named, not shown. One grouped read for dates, one for apps. */
export function resolveRepos(db: Database, pack: CuratedPack, viewer: User | undefined): PackRepo[] {
  const found = pack.repos.map((full) => {
    const [owner = "", name = ""] = full.split("/");
    return { full, repo: getRepo(db, owner, name) };
  });
  const shown = found.flatMap((f) => (f.repo !== undefined && f.repo.visibility === "public" && canRead(db, f.repo, viewer) ? [f.repo] : []));
  const ids = shown.map((r) => r.id);
  const dates = ids.length === 0 ? new Map() : repoDatesFor(db, ids);
  const live = new Set(
    ids.length === 0
      ? []
      : db.query<{ repo_id: string }, string[]>(`SELECT repo_id FROM app WHERE repo_id IN (${ids.map(() => "?").join(",")})`).all(...ids).map((r) => r.repo_id),
  );
  return found.map(({ full, repo }): PackRepo => {
    if (repo === undefined) return { full, description: "", live: false, pushedAt: null, left: "not on this forge" };
    if (!ids.includes(repo.id)) return { full, description: "", live: false, pushedAt: null, left: "not public" };
    return {
      full: `${repo.ownerName}/${repo.name}`,
      description: repo.description,
      live: live.has(repo.id),
      pushedAt: dates.get(repo.id)?.pushedAt ?? null,
    };
  });
}
