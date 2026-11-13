/**
 * Contribute tokens (#12012): the credential an outside agent with its own
 * sandbox (Codex cloud, Jules, Claude Code, Cursor) is handed to contribute by
 * clone and push. It is an ordinary `rw` token for a throwaway guest account the
 * forge makes, limited by `http/contribute_gate.ts` to: reading public
 * repositories, pushing `contrib/<agent>/…` branches on the one repository that
 * opted in, opening and reading its own pulls there. It expires in a day,
 * renews once, and the agent's name and origin are kept as claimed, never
 * verified. `allows` is the scope check: plain data in, a yes or no out.
 */

import type { Database } from "bun:sqlite";
import { isSafeRef } from "../git/guard.ts";
import { sha256 } from "../kernel/hash.ts";
import { createToken } from "./tokens.ts";

export interface ContributeScope {
  readonly tokenId: string;
  readonly repoId: string;
  readonly agent: string;
  /** `<agent>/<segment>`: the branches under `contrib/` this token alone may touch. */
  readonly namespace: string;
}

/**
 * A segment of the push namespace that only this token has. The agent name is
 * claimed, so two tokens may share one; the segment (from the token's random id)
 * keeps one from force-pushing over or deleting the other's branches.
 */
export const contribSegment = (tokenId: string): string => sha256(`contribute-segment:${tokenId}`).slice(0, 8);

export const contribNamespace = (agent: string, tokenId: string): string => `${agent}/${contribSegment(tokenId)}`;

export const CONTRIBUTE_TTL_MS = 24 * 3600_000;
/** A renewal never carries a token past this long after it was minted. */
export const CONTRIBUTE_MAX_LIFE_MS = 7 * 24 * 3600_000;
export const MINTS_PER_HOUR = 5;
export const MINTS_PER_DAY = 20;
/**
 * Pulls one token may have open, and may open in a day; and all of a repository's
 * outside tokens together in a day.
 */
export const OPEN_PULLS_PER_TOKEN = 5;
export const PULLS_PER_TOKEN_DAY = 20;
export const PULLS_PER_REPO_DAY = 30;
export const AGENT_MAX = 64;
export const ORIGIN_MAX = 200;

/** An agent's claimed name: letters, digits, . _ - ; it starts with a letter or digit. */
export const isAgentName = (name: unknown): name is string =>
  typeof name === "string" && name.length <= AGENT_MAX && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !/\.\./.test(name);

/** Where the agent says it runs from: short plain text, nothing a page could misread. */
export const isOrigin = (origin: unknown): origin is string =>
  typeof origin === "string" && origin.length <= ORIGIN_MAX && !/[\x00-\x1f\x7f<>]/.test(origin);

/** Whether `ref` (full `refs/heads/…`) is a branch under `contrib/<agent>/`. */
export function inContribNamespace(ref: string, agent: string): boolean {
  const prefix = `refs/heads/contrib/${agent}/`;
  if (!ref.startsWith(prefix) || ref.length > 200 || !isSafeRef(ref)) return false;
  return ref
    .slice(prefix.length)
    .split("/")
    .every((part) => /^[A-Za-z0-9._-]+$/.test(part) && !/^\.+$/.test(part));
}

/** A pull's head branch name (no `refs/heads/`) inside the namespace. */
export const headInContribNamespace = (head: string, agent: string): boolean =>
  inContribNamespace(`refs/heads/${head}`, agent);

/**
 * Why this token's user may not open another pull on `repoId` now, or undefined.
 * Counted from the pull rows themselves: open ones by this author, and the day's
 * by this author and by every outside token's author on the repository.
 */
export function pullCapReached(
  db: Database,
  repoId: string,
  userId: string,
  now: Date,
): "token_open" | "token_day" | "repo_day" | undefined {
  const count = (sql: string, ...args: string[]): number =>
    db.query<{ n: number }, string[]>(sql).get(...args)?.n ?? 0;
  const since = new Date(now.getTime() - 86_400_000).toISOString();
  const mine = "SELECT COUNT(*) AS n FROM issue WHERE repo_id = ?1 AND kind = 'pull' AND author_id = ?2";
  if (count(`${mine} AND state = 'open'`, repoId, userId) >= OPEN_PULLS_PER_TOKEN) return "token_open";
  if (count(`${mine} AND created_at >= ?3`, repoId, userId, since) >= PULLS_PER_TOKEN_DAY) return "token_day";
  const all = count(
    `SELECT COUNT(*) AS n FROM issue
      WHERE repo_id = ?1 AND kind = 'pull' AND created_at >= ?2
        AND author_id IN (SELECT t.user_id FROM token t JOIN contribute_token c ON c.token_id = t.id WHERE c.repo_id = ?1)`,
    repoId,
    since,
  );
  return all >= PULLS_PER_REPO_DAY ? "repo_day" : undefined;
}

/** What a request is, as the scope check reads it. */
export interface ContributeAsk {
  readonly method: string;
  readonly path: string;
  /** `service` of a git info/refs request. */
  readonly service?: string | null;
  /** The pull number the path names, when that pull is the token's own. */
  readonly ownPull?: boolean;
}

/** Forge-wide reads open to the token. */
const FORGE_READS = new Set(["/api/v1/here", "/api/v1/search", "/api/v1/explore", "/api/v1/openapi.json", "/api/v1/contribute"]);

/**
 * Whether the token may make this request. `repo` is the one it was minted
 * for. Allow-listed: a route added tomorrow is closed to it until written here.
 * Handlers still apply the guest account's own access on top, so a private
 * repository stays hidden.
 */
export function allows(scope: ContributeScope, repo: { owner: string; name: string }, ask: ContributeAsk): boolean {
  const read = ask.method === "GET" || ask.method === "HEAD";
  const path = ask.path.toLowerCase();
  if (read && FORGE_READS.has(path)) return true;
  if (ask.method === "POST" && path === "/api/v1/contribute") return true; // renews
  const at = `/${repo.owner}/${repo.name}`.toLowerCase();
  const api = `/api/v1/repos${at}`;
  // The one repository: push, open a pull, and update or read its own.
  if (read && path === `${at}.git/info/refs` && ask.service === "git-receive-pack") return true;
  // Any public repository may be read: its API, and a fetch.
  if (read && path.startsWith("/api/v1/repos/")) return true;
  if (read && /^\/[^/]+\/[^/]+\.git\/info\/refs$/.test(path)) return ask.service === "git-upload-pack";
  if (ask.method === "POST" && /^\/[^/]+\/[^/]+\.git\/git-upload-pack$/.test(path)) return true;
  if (ask.method === "POST" && path === `${at}.git/git-receive-pack`) return true;
  if (ask.method === "POST" && path === `${api}/pulls`) return true;
  if ((ask.method === "PATCH" || ask.method === "POST") && ask.ownPull === true && path.startsWith(`${api}/pulls/`)) return true;
  return false;
}

/** The pull number a path names under `repo`'s pulls, or undefined. */
export function pullNumberIn(path: string, repo: { owner: string; name: string }): number | undefined {
  const head = `/api/v1/repos/${repo.owner}/${repo.name}/pulls/`.toLowerCase();
  const lower = path.toLowerCase();
  if (!lower.startsWith(head)) return undefined;
  const m = /^([1-9][0-9]{0,8})(?:\/|$)/.exec(lower.slice(head.length));
  return m ? Number(m[1]) : undefined;
}

// ---- the rows ----

/** A source (an address) is kept only as a hash: enough to count, never to read. */
const sourceKey = (source: string): string => sha256(`contribute-source:${source}`).slice(0, 24);

export const contributeOpen = (db: Database, repoId: string): boolean =>
  db.query("SELECT 1 FROM contribute_open WHERE repo_id = ?1").get(repoId) !== null;

export function setContributeOpen(db: Database, repoId: string, on: boolean): void {
  if (on) db.query("INSERT OR IGNORE INTO contribute_open (repo_id) VALUES (?1)").run(repoId);
  else db.query("DELETE FROM contribute_open WHERE repo_id = ?1").run(repoId);
}

export function mintsSince(db: Database, since: number, source: string): number {
  return (
    db
      .query<{ n: number }, [string, number]>("SELECT COUNT(*) AS n FROM contribute_mint WHERE source = ?1 AND made_at >= ?2")
      .get(sourceKey(source), since)?.n ?? 0
  );
}

export interface Minted {
  readonly id: string;
  readonly token: string;
  readonly expiresAt: string;
}

/** Mint the token for `userId` on `repoId`, and count it against `source`. */
export function mintContribute(
  db: Database,
  input: { userId: string; repoId: string; agent: string; origin: string; source: string },
  now: Date,
): Minted {
  const expiresAt = new Date(now.getTime() + CONTRIBUTE_TTL_MS).toISOString();
  const minted = createToken(db, input.userId, `contribute:${input.agent}`, "rw", { expiresAt });
  db.query(
    "INSERT INTO contribute_token (token_id, repo_id, agent, origin, minted_at) VALUES (?1, ?2, ?3, ?4, ?5)",
  ).run(minted.id, input.repoId, input.agent, input.origin, now.toISOString());
  db.query("INSERT INTO contribute_mint (source, made_at) VALUES (?1, ?2)").run(sourceKey(input.source), now.getTime());
  // The ledger only needs the last day.
  db.query("DELETE FROM contribute_mint WHERE made_at < ?1").run(now.getTime() - 2 * 24 * 3600_000);
  return { ...minted, expiresAt };
}

/** Extend a token by another day, once, never past a week from its minting. */
export function renewContribute(
  db: Database,
  tokenId: string,
  now: Date,
): { ok: true; expiresAt: string } | { ok: false; error: "already_renewed" | "not_found" } {
  const row = db
    .query<{ minted_at: string; renewed: number }, [string]>("SELECT minted_at, renewed FROM contribute_token WHERE token_id = ?1")
    .get(tokenId);
  if (row === null) return { ok: false, error: "not_found" };
  if (row.renewed !== 0) return { ok: false, error: "already_renewed" };
  const until = Math.min(now.getTime() + CONTRIBUTE_TTL_MS, Date.parse(row.minted_at) + CONTRIBUTE_MAX_LIFE_MS);
  const expiresAt = new Date(until).toISOString();
  db.transaction(() => {
    db.query("UPDATE token SET expires_at = ?1 WHERE id = ?2").run(expiresAt, tokenId);
    db.query("UPDATE contribute_token SET renewed = 1 WHERE token_id = ?1").run(tokenId);
  })();
  return { ok: true, expiresAt };
}

export interface ContributeTokenInfo {
  readonly id: string;
  readonly agent: string;
  /** As the agent claimed it; never verified. */
  readonly origin: string;
  readonly mintedAt: string;
  readonly expiresAt: string;
  readonly lastUsedAt: string | null;
  readonly renewed: boolean;
}

/** The live tokens on a repository: unexpired, newest first. */
export function listContribute(db: Database, repoId: string, now: Date): ContributeTokenInfo[] {
  return db
    .query<
      { id: string; agent: string; origin: string; minted_at: string; expires_at: string; last_used_at: string | null; renewed: number },
      [string, string]
    >(
      `SELECT c.token_id AS id, c.agent, c.origin, c.minted_at, t.expires_at, t.last_used_at, c.renewed
         FROM contribute_token c JOIN token t ON t.id = c.token_id
        WHERE c.repo_id = ?1 AND t.expires_at > ?2 ORDER BY c.minted_at DESC, c.token_id DESC`,
    )
    .all(repoId, now.toISOString())
    .map((r) => ({
      id: r.id,
      agent: r.agent,
      origin: r.origin,
      mintedAt: r.minted_at,
      expiresAt: r.expires_at,
      lastUsedAt: r.last_used_at,
      renewed: r.renewed === 1,
    }));
}

/** Revoke one token of `repoId`; false when it is not one of that repository's. */
export function revokeContribute(db: Database, repoId: string, tokenId: string): boolean {
  const own = db
    .query("SELECT 1 FROM contribute_token WHERE token_id = ?1 AND repo_id = ?2")
    .get(tokenId, repoId);
  if (own === null) return false;
  db.query("DELETE FROM token WHERE id = ?1").run(tokenId);
  return db.query("SELECT 1 FROM token WHERE id = ?1").get(tokenId) === null;
}
