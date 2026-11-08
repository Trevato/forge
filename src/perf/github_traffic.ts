/**
 * GitHub's own repository traffic (referrers, views, clones), which GitHub keeps
 * for 14 days, pulled once a day into the same store (`github_traffic`) so it
 * outlives them. Off unless `FORGE_GITHUB_TOKEN` (a token that may read the
 * repositories' traffic: push access) and `FORGE_GITHUB_REPOS`
 * (`owner/name,owner/name`) are set. The token is read from the environment,
 * sent only to api.github.com, and never stored or printed. Every answer is
 * validated before it is written; a failure is recorded against the repository
 * and the next day tries again.
 */

import type { Database } from "bun:sqlite";
import { quietly } from "../core/write_clock.ts";

const API = "https://api.github.com";
const REPO = /^(?!\.+\/)[A-Za-z0-9_.-]{1,100}\/(?!\.+$)[A-Za-z0-9_.-]{1,100}$/;
const PULL_EVERY_MS = 23 * 3_600_000;
const CHECK_MS = 3_600_000;

export type Fetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

export interface GithubConfig {
  readonly token: string;
  readonly repos: readonly string[];
}

export function githubConfig(env: Record<string, string | undefined> = process.env): GithubConfig | null {
  const token = env["FORGE_GITHUB_TOKEN"]?.trim() ?? "";
  const repos = (env["FORGE_GITHUB_REPOS"] ?? "").split(",").map((r) => r.trim()).filter((r) => REPO.test(r));
  return token === "" || repos.length === 0 ? null : { token, repos };
}

interface Entry {
  readonly day: string;
  readonly kind: "views" | "clones" | "referrers";
  readonly key: string;
  readonly count: number;
  readonly uniques: number;
}

const whole = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0 && n < 1e9;
const arrayOf = (o: unknown, key: string): unknown[] | null => {
  const v = typeof o === "object" && o !== null ? (o as Record<string, unknown>)[key] : undefined;
  return Array.isArray(v) ? v : null;
};

/** GitHub's three answers as rows, or why not. Referrers are a 14-day total: filed under the day of the pull. */
export function entriesOf(
  kind: Entry["kind"],
  answer: unknown,
  today: string,
): Entry[] | "malformed" {
  const list = kind === "referrers" ? (Array.isArray(answer) ? answer : null) : arrayOf(answer, kind);
  if (list === null) return "malformed";
  const out: Entry[] = [];
  for (const item of list.slice(0, 200)) {
    const r = item as Record<string, unknown>;
    if (typeof item !== "object" || item === null || !whole(r["count"]) || !whole(r["uniques"])) return "malformed";
    if (kind === "referrers") {
      const key = r["referrer"];
      if (typeof key !== "string" || key.length === 0 || key.length > 100 || !/^[A-Za-z0-9._ -]+$/.test(key)) return "malformed";
      out.push({ day: today, kind, key, count: r["count"], uniques: r["uniques"] });
    } else {
      const stamp = r["timestamp"];
      if (typeof stamp !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(stamp)) return "malformed";
      out.push({ day: stamp.slice(0, 10), kind, key: "", count: r["count"], uniques: r["uniques"] });
    }
  }
  return out;
}

/** Pull every configured repository; returns how many were stored. Never throws. */
export async function pullGithub(
  db: Database,
  config: GithubConfig,
  fetcher: Fetch = (url, init) => fetch(url, init),
  now: number = Date.now(),
): Promise<number> {
  const today = new Date(now).toISOString().slice(0, 10);
  let stored = 0;
  for (const repo of config.repos) {
    let error: string | null = null;
    const rows: Entry[] = [];
    for (const [kind, path] of [["referrers", "popular/referrers"], ["views", "views"], ["clones", "clones"]] as const) {
      try {
        const signal = AbortSignal.timeout(15_000);
        const res = await fetcher(`${API}/repos/${repo}/traffic/${path}`, {
          headers: {
            authorization: `Bearer ${config.token}`,
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
            "user-agent": "forge-traffic",
          },
          signal,
        });
        if (!res.ok) {
          error = `${kind}: GitHub answered ${res.status}`;
          break;
        }
        const entries = entriesOf(kind, await res.json(), today);
        if (entries === "malformed") {
          error = `${kind}: unexpected answer`;
          break;
        }
        rows.push(...entries);
      } catch (e) {
        error = `${kind}: ${e instanceof Error ? e.name : "failed"}`;
        break;
      }
    }
    quietly(db, () =>
      db.transaction(() => {
        if (error === null) {
          const put = db.query(
            `INSERT INTO github_traffic (repo, day, kind, key, count, uniques) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT (repo, day, kind, key) DO UPDATE SET count = excluded.count, uniques = excluded.uniques`,
          );
          for (const r of rows) put.run(repo, r.day, r.kind, r.key, r.count, r.uniques);
          stored += 1;
        }
        db.query(
          `INSERT INTO github_pull (repo, pulled_at, error) VALUES (?1, ?2, ?3)
           ON CONFLICT (repo) DO UPDATE SET pulled_at = excluded.pulled_at, error = excluded.error`,
        ).run(repo, now, error);
      })(),
    );
  }
  return stored;
}

/** Whether any repository has not been pulled in the last day. */
export function pullDue(db: Database, config: GithubConfig, now: number): boolean {
  const last = new Map(
    db.query<{ repo: string; pulled_at: number }, []>("SELECT repo, pulled_at FROM github_pull").all().map((r) => [r.repo, r.pulled_at]),
  );
  return config.repos.some((r) => now - (last.get(r) ?? 0) >= PULL_EVERY_MS);
}

/** The daily pull, started by the server; null when no token or repository is set. */
export function startGithubPull(
  db: Database,
  log: { warn(message: string, fields?: Record<string, unknown>): void },
  env: Record<string, string | undefined> = process.env,
  fetcher?: Fetch,
): { stop(): void } | null {
  const config = githubConfig(env);
  if (config === null) return null;
  const run = (): void => {
    if (!pullDue(db, config, Date.now())) return;
    pullGithub(db, config, fetcher).catch((error) => log.warn("could not pull GitHub traffic", { error: String(error) }));
  };
  const first = setTimeout(run, 30_000);
  const tick = setInterval(run, CHECK_MS);
  first.unref();
  tick.unref();
  return {
    stop() {
      clearTimeout(first);
      clearInterval(tick);
    },
  };
}

export interface GithubRepoSummary {
  readonly repo: string;
  readonly views: number;
  readonly viewers: number;
  readonly clones: number;
  readonly cloners: number;
  readonly referrers: readonly { key: string; count: number; uniques: number }[];
  readonly pulledAt: number | null;
  readonly error: string | null;
}

/** Each pulled repository's totals since `sinceDay`, and its latest referrers. */
export function githubSummary(db: Database, sinceDay: string): GithubRepoSummary[] {
  const repos = db.query<{ repo: string; pulled_at: number; error: string | null }, []>("SELECT repo, pulled_at, error FROM github_pull ORDER BY repo").all();
  return repos.map((p) => {
    const sum = (kind: string): { count: number; uniques: number } =>
      db
        .query<{ count: number; uniques: number }, [string, string, string]>(
          "SELECT COALESCE(SUM(count), 0) AS count, COALESCE(SUM(uniques), 0) AS uniques FROM github_traffic WHERE repo = ?1 AND kind = ?2 AND day >= ?3",
        )
        .get(p.repo, kind, sinceDay) ?? { count: 0, uniques: 0 };
    const latest = db
      .query<{ day: string }, [string]>("SELECT MAX(day) AS day FROM github_traffic WHERE repo = ?1 AND kind = 'referrers'")
      .get(p.repo)?.day;
    const referrers =
      latest === undefined || latest === null
        ? []
        : db
            .query<{ key: string; count: number; uniques: number }, [string, string]>(
              "SELECT key, count, uniques FROM github_traffic WHERE repo = ?1 AND kind = 'referrers' AND day = ?2 ORDER BY count DESC, key LIMIT 10",
            )
            .all(p.repo, latest);
    const v = sum("views");
    const c = sum("clones");
    return { repo: p.repo, views: v.count, viewers: v.uniques, clones: c.count, cloners: c.uniques, referrers, pulledAt: p.pulled_at, error: p.error };
  });
}
