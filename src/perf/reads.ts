/**
 * What was read from repositories, not only how much: repository, ref (branch
 * or commit) and path of every file, tree and commit page, counted in memory
 * as requests finish and written once a minute into `read_hour` (kept 7 days).
 * No address is kept here. A path that looks like a secret or a credential is
 * flagged (`secretPath`) so an admin sees a scraper going for keys.
 *
 * Bounded twice: at most `MAX_KEYS` distinct reads wait in memory between
 * writes, and a stored hour holds at most `HOUR_KEYS_MAX` distinct rows however
 * many minutes wrote to it; later ones fall under `OTHER_PATH` for their
 * repository. So the table cannot pass `HOUR_KEYS_MAX` x 168 rows plus the
 * folds, and the report reads it grouped in SQL, never row by row.
 */

import type { Database } from "bun:sqlite";
import { runGit } from "../git/env.ts";
import { withoutWaiting } from "../kernel/db.ts";
import { quietly } from "../core/write_clock.ts";
import { during } from "./jobs.ts";

const HOUR_MS = 3_600_000;
const MAX_KEYS = 2_000;
/** Distinct (repo, ref, path) rows one hour may hold in the table; later ones fold into `(others)` for their repository. */
export const HOUR_KEYS_MAX = 500;
const FLUSH_MS = 60_000;
export const READ_DAYS_MAX = 7;
export const OTHER_PATH = "(others)";

export interface Read {
  readonly repo: string;
  readonly ref: string;
  readonly path: string;
}

const clean = (text: string, max: number): string =>
  // eslint-disable-next-line no-control-regex
  text.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max);

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

const FILE_ROUTE = /^\/:owner\/:name\/(blob|raw|tree|commit)\//;
const FILE_PATH = /^\/([^/]+)\/([^/]+)\/(blob|raw|tree|commit)\/([^/]+)(?:\/(.*))?$/;

/** The repository, ref and path a file, tree or commit route read; null for any other route. */
export function readOf(pattern: string, pathname: string): Read | null {
  if (!FILE_ROUTE.test(pattern)) return null;
  const m = FILE_PATH.exec(pathname);
  if (m === null) return null;
  const path = m[3] === "commit" ? "" : decode(m[5] ?? "");
  return {
    repo: clean(`${decode(m[1]!)}/${decode(m[2]!)}`, 120),
    ref: clean(decode(m[4]!), 80),
    path: clean(path, 300),
  };
}

/** A ref that is a commit id (7 to 64 hex characters) rather than a branch name. */
export const isCommit = (ref: string): boolean => /^[0-9a-f]{7,64}$/.test(ref);

const SECRET = [
  /(^|\/)\.env(\.[^/]*)?$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|jks|kdbx|keystore)$/i,
  /(^|\/)\.(npmrc|netrc|pgpass|htpasswd|git-credentials|dockercfg|pypirc)$/i,
  /(^|\/)(credentials|secrets?)(\.[^/]*)?$/i,
  /(^|\/)\.(aws|ssh|gnupg|kube)\//i,
  /(^|\/)service[-_]account[^/]*\.json$/i,
  /(^|\/)wp-config\.php$/i,
  /(^|\/)\.docker\/config\.json$/i,
  /(^|\/)(terraform\.tfstate|\.tfvars|[^/]*\.tfvars)$/i,
];

/** The file's name or place says it holds a secret or a credential: a guess from the path, never from the content. */
export const secretPath = (path: string): boolean => SECRET.some((r) => r.test(path));

interface Count {
  requests: number;
  anonymous: number;
}

export interface ReadLedger {
  note(at: number, read: Read, anonymous: boolean): void;
  /** What waits to be written, for the page to add to what is stored. */
  pending(): ReadRow[];
  drain(): Map<number, Map<string, Count>>;
}

export interface ReadRow extends Read {
  readonly hour: number;
  readonly requests: number;
  readonly anonymous: number;
}

const SEP = "\u0000";

export function createReadLedger(): ReadLedger {
  let held = new Map<number, Map<string, Count>>();
  let size = 0;
  return {
    note(at, read, anonymous) {
      const hour = Math.floor(at / HOUR_MS);
      let table = held.get(hour);
      if (table === undefined) held.set(hour, (table = new Map()));
      let key = [read.repo, read.ref, read.path].join(SEP);
      if (!table.has(key)) {
        if (size >= MAX_KEYS) key = [read.repo, "", OTHER_PATH].join(SEP);
        else size++;
      }
      const c = table.get(key) ?? { requests: 0, anonymous: 0 };
      c.requests++;
      if (anonymous) c.anonymous++;
      table.set(key, c);
    },
    pending() {
      const rows: ReadRow[] = [];
      for (const [hour, table] of held)
        for (const [key, c] of table) {
          const [repo, ref, path] = key.split(SEP) as [string, string, string];
          rows.push({ hour, repo, ref, path, ...c });
        }
      return rows;
    },
    drain() {
      const out = held;
      held = new Map();
      size = 0;
      return out;
    },
  };
}

export interface ReadWriter {
  flush(): void;
  stop(): void;
}

export function createReadWriter(
  db: Database,
  ledger: ReadLedger,
  log: { warn(message: string, fields?: Record<string, unknown>): void },
  now: () => number = Date.now,
  flushMs: number = FLUSH_MS,
): ReadWriter {
  const flush = (): void => {
    const drained = ledger.drain();
    try {
      withoutWaiting(
        db,
        db.transaction(() =>
          quietly(db, () => {
            const put = db.query(
              `INSERT INTO read_hour (hour, repo, ref, path, requests, anonymous)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6)
               ON CONFLICT (hour, repo, ref, path) DO UPDATE SET
                 requests = requests + excluded.requests,
                 anonymous = anonymous + excluded.anonymous`,
            );
            const held = db.query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM read_hour WHERE hour = ?1");
            const has = db.query<{ one: number }, [number, string, string, string]>(
              "SELECT 1 AS one FROM read_hour WHERE hour = ?1 AND repo = ?2 AND ref = ?3 AND path = ?4",
            );
            for (const [hour, table] of drained) {
              let rows = held.get(hour)?.n ?? 0;
              for (const [key, c] of table) {
                let [repo, ref, path] = key.split(SEP) as [string, string, string];
                if (has.get(hour, repo, ref, path) === null) {
                  if (rows >= HOUR_KEYS_MAX && path !== OTHER_PATH) {
                    ref = "";
                    path = OTHER_PATH;
                    if (has.get(hour, repo, ref, path) === null) rows++;
                  } else rows++;
                }
                put.run(hour, repo, ref, path, c.requests, c.anonymous);
              }
            }
            db.query("DELETE FROM read_hour WHERE hour < ?1").run(
              Math.floor(now() / HOUR_MS) - READ_DAYS_MAX * 24,
            );
          }),
        ),
      );
    } catch (error) {
      // A failed write loses that minute's reads; evidence, not a ledger.
      log.warn("could not write read history", { error: String(error) });
    }
  };
  const tick = setInterval(() => during("reads", flush), flushMs);
  tick.unref();
  return {
    flush,
    stop() {
      clearInterval(tick);
      flush();
    },
  };
}

export interface PathRow {
  readonly path: string;
  readonly requests: number;
  readonly anonymous: number;
  readonly secret: boolean;
}

export interface RepoReads {
  readonly repo: string;
  readonly requests: number;
  readonly anonymous: number;
  /** Distinct file or tree paths read. */
  readonly paths: number;
  /** Most-read commits (by id), then branches. */
  readonly commits: readonly { ref: string; requests: number }[];
  readonly topPaths: readonly PathRow[];
  readonly secrets: readonly PathRow[];
  /** Files at HEAD, and the share of them the window read; filled by `addCoverage`. */
  files?: number | null;
  coverage?: number | null;
}

/** The window's reads grouped by repository, busiest first; `days` is cut to 1..7. */
export function readsReport(
  db: Database,
  ledger: ReadLedger,
  now: number,
  days: number,
): RepoReads[] {
  const d = Math.min(READ_DAYS_MAX, Math.max(1, Math.floor(days) || 1));
  const since = Math.floor(now / HOUR_MS) - d * 24 + 1;
  // Grouped in SQL: one row per repository and path, one per repository and ref.
  const byPath = db
    .query<ReadRow, [number]>(
      `SELECT 0 AS hour, repo, '' AS ref, path, SUM(requests) AS requests, SUM(anonymous) AS anonymous
       FROM read_hour WHERE hour >= ?1 GROUP BY repo, path`,
    )
    .all(since);
  const byRef = db
    .query<ReadRow, [number]>(
      `SELECT 0 AS hour, repo, ref, '' AS path, SUM(requests) AS requests, SUM(anonymous) AS anonymous
       FROM read_hour WHERE hour >= ?1 AND ref != '' GROUP BY repo, ref`,
    )
    .all(since);
  const waiting = ledger.pending().filter((r) => r.hour >= since);
  const rows = [...byPath, ...waiting];
  const byRepo = new Map<string, ReadRow[]>();
  for (const r of rows) {
    let list = byRepo.get(r.repo);
    if (list === undefined) byRepo.set(r.repo, (list = []));
    list.push(r);
  }
  const refRows = [...byRef, ...waiting.filter((r) => r.ref !== "")];
  const refsOf = new Map<string, Map<string, number>>();
  for (const r of refRows) {
    let m = refsOf.get(r.repo);
    if (m === undefined) refsOf.set(r.repo, (m = new Map()));
    m.set(r.ref, (m.get(r.ref) ?? 0) + r.requests);
  }
  const out: RepoReads[] = [];
  for (const [repo, list] of byRepo) {
    const paths = new Map<string, Count>();
    const refs = refsOf.get(repo) ?? new Map<string, number>();
    let requests = 0;
    let anonymous = 0;
    for (const r of list) {
      requests += r.requests;
      anonymous += r.anonymous;
      if (r.path !== "" && r.path !== OTHER_PATH) {
        const c = paths.get(r.path) ?? { requests: 0, anonymous: 0 };
        c.requests += r.requests;
        c.anonymous += r.anonymous;
        paths.set(r.path, c);
      }
    }
    const all: PathRow[] = [...paths]
      .map(([path, c]) => ({ path, ...c, secret: secretPath(path) }))
      .sort((a, b) => b.requests - a.requests || a.path.localeCompare(b.path));
    out.push({
      repo,
      requests,
      anonymous,
      paths: paths.size,
      commits: [...refs]
        .map(([ref, n]) => ({ ref, requests: n }))
        .sort((a, b) => Number(isCommit(b.ref)) - Number(isCommit(a.ref)) || b.requests - a.requests)
        .slice(0, 5),
      topPaths: all.slice(0, 5),
      secrets: all.filter((p) => p.secret).slice(0, 10),
    });
  }
  return out.sort((a, b) => b.requests - a.requests || a.repo.localeCompare(b.repo)).slice(0, 20);
}

/** How much of the repository the window's reads reached: distinct paths read over files at HEAD. Null when git cannot say. */
export async function addCoverage(
  report: RepoReads,
  dirOf: (repo: string) => string | null,
): Promise<RepoReads> {
  const dir = dirOf(report.repo);
  if (dir === null) return { ...report, files: null, coverage: null };
  const listed = await runGit(["ls-tree", "-r", "--name-only", "HEAD"], { cwd: dir });
  if (!listed.ok) return { ...report, files: null, coverage: null };
  const files = listed.value === "" ? 0 : listed.value.split("\n").length;
  return {
    ...report,
    files,
    coverage: files === 0 ? null : Math.min(1, report.paths / files),
  };
}
