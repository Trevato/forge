/**
 * What became of a new forge's first ask (#11788): who has it, or exactly what
 * is missing, or that it waits. One reading for the home card and the
 * terminal home, so both say the same thing. Plain data in, plain data out.
 */

import type { Database } from "bun:sqlite";
import type { App } from "../app.ts";
import { listReposOwnedBy, type Repo } from "./repos.ts";
import { spawnedRepos } from "./next-steps.ts";
import { getUserById, type User } from "./users.ts";

/** What became of the ask, in one word, so a page can tell one state from another without reading the words. */
export type AskState = "building" | "missing" | "stopped" | "cancelled" | "finished" | "queued" | "ready" | "waiting";

/** The words, the app and issue they name, and the one action when something is missing. */
export interface AskStatus {
  readonly state: AskState;
  readonly says: string;
  readonly repoId: string;
  readonly app: string;
  readonly issueNumber: number;
  readonly href: string;
  readonly action: { readonly href: string; readonly label: string } | null;
}

interface RunAt {
  readonly id: string;
  readonly state: string;
  readonly branch: string;
  readonly actor_id: string | null;
  readonly created_at: string;
}

/**
 * The first ask `askerId` made on `repos` (their oldest issue there, open or
 * not, so a later issue never replaces it; an app's direction is no ask) and
 * what became of it. `canRun`: the crew has a
 * key or credit. Null when nothing was asked, or once the first ask is over:
 * closed, or its builder opened a pull (the pull says the rest).
 */
export function askStatus(
  db: Database,
  repos: readonly Repo[],
  askerId: string,
  canRun: boolean,
  admin: boolean,
): AskStatus | null {
  if (repos.length === 0) return null;
  const marks = repos.map(() => "?").join(",");
  const ids = repos.map((r) => r.id);
  const found = db
    .query<{ id: string; repo_id: string; number: number; state: string; assignee_id: string | null }, string[]>(
      `SELECT id, repo_id, number, state, assignee_id FROM issue
       WHERE kind = 'issue' AND author_id = ? AND repo_id IN (${marks})
         AND id NOT IN (SELECT direction_issue_id FROM repo WHERE direction_issue_id IS NOT NULL)
       ORDER BY created_at ASC, number ASC LIMIT 1`,
    )
    .get(askerId, ...ids);
  const repo = repos.find((r) => r.id === found?.repo_id);
  if (!found || !repo || found.state !== "open") return null;
  const run = db
    .query<RunAt, [string]>(
      `SELECT id, state, branch, actor_id, created_at FROM run
       WHERE issue_id = ?1 AND kind = 'agent' ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(found.id);
  if (run && pulled(db, repo.id, found.id)) return null;
  const named = { repoId: repo.id, app: repo.name, issueNumber: found.number, href: `/${repo.ownerName}/${repo.name}/issues/${found.number}` };
  const say = (state: AskState, says: string): AskStatus => ({ ...named, state, says, action: null });
  const whoId = found.assignee_id ?? run?.actor_id ?? null;
  const who = (whoId === null ? null : getUserById(db, whoId)?.username) ?? "The builder";
  if (run?.state === "running") return say("building", `${who} is building it`);
  if (!canRun)
    return {
      ...say("missing", "No AI account and no included credit left: add a key"),
      action: admin ? { href: "/settings/subscriptions", label: "Add a model key" } : { href: "/pricing", label: "See the plans" },
    };
  if (run?.state === "failed") return say("stopped", `${who} stopped on it: the run failed`);
  if (run?.state === "cancelled") return say("cancelled", `${who}'s run on it was cancelled`);
  if (run?.state === "ok") return say("finished", `${who} finished a run on it and opened no pull`);
  if (run?.state === "queued") {
    const ahead = queuedAhead(db, ids, run);
    return say("queued", ahead === 0 ? "Next in line for a builder" : `Waiting for a builder: ${ahead} ahead of it`);
  }
  if (found.assignee_id !== null) return say("ready", `${who} is ready to start on it`);
  return say("waiting", "Waiting for a builder");
}

/** Where a person's asks land: the spawned forge's apps and the apps they own (a first ask makes one of their own). */
export async function askRepos(app: App, user: User): Promise<readonly Repo[]> {
  const spawned = await spawnedRepos(app, user);
  const seen = new Set(spawned.map((r) => r.id));
  return [...spawned, ...listReposOwnedBy(app.db, user.id).filter((r) => !seen.has(r.id))];
}

/** Whether any agent run on the issue pushed a branch a pull was opened from. */
function pulled(db: Database, repoId: string, issueId: string): boolean {
  return (
    db
      .query<{ one: number }, [string, string]>(
        `SELECT 1 AS one FROM run r JOIN pull p ON r.branch != '' AND p.head_branch = r.branch
         JOIN issue i ON i.id = p.issue_id AND i.repo_id = ?1
         WHERE r.issue_id = ?2 AND r.kind = 'agent' LIMIT 1`,
      )
      .get(repoId, issueId) !== null
  );
}

/** The queued agent runs on `repoIds` made before `run`: its real place in line. */
function queuedAhead(db: Database, repoIds: readonly string[], run: RunAt): number {
  return (
    db
      .query<{ n: number }, string[]>(
        `SELECT COUNT(*) AS n FROM run
         WHERE kind = 'agent' AND state = 'queued' AND id != ? AND repo_id IN (${repoIds.map(() => "?").join(",")})
           AND (created_at < ? OR (created_at = ? AND id < ?))`,
      )
      .get(run.id, ...repoIds, run.created_at, run.created_at, run.id)?.n ?? 0
  );
}

/** The terminal's one line: the words, what they name, and the way forward when something is missing. */
export function askStatusLine(s: AskStatus): string {
  return `${s.says} (${s.app}, issue #${s.issueNumber})${s.action ? `. ${s.action.label} at ${s.action.href}` : ""}`;
}
