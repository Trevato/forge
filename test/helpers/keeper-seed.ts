/** A bare forge for the flow keeper's tests: rows written straight, so each test names the one fact it is about. */
import type { Database } from "bun:sqlite";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../../src/app.ts";

export const ago = (now: Date, minutes: number): string => new Date(now.getTime() - minutes * 60_000).toISOString();

export interface Seed {
  readonly app: App;
  readonly db: Database;
  readonly repoId: string;
  readonly owner: string;
  /** Builders on the crew, by name. */
  readonly builders: Record<string, string>;
  readonly person: string;
  user(name: string, agent: boolean): string;
  pull(o: { number: number; author: string; assignee?: string | null; head?: string; approved?: boolean; createdAt: string; headRepoId?: string }): string;
  run(o: { pull: string; kind: string; state: string; head: string; at: string; reason?: string }): void;
  hold(pull: string, by: string, at: string, untilGreen?: boolean): void;
}

let n = 0;
const nid = (p: string): string => `${p}${(++n).toString().padStart(6, "0")}`;

export async function seed(names: string[] = ["ada", "bo"]): Promise<Seed> {
  const dir = await mkdtemp(join(tmpdir(), "forge-keeper-seed-"));
  const app = createApp({ dataDir: dir, port: 0 });
  const db = app.db;
  const user = (name: string, agent: boolean): string => {
    const id = nid("u");
    db.query("INSERT INTO user (id, username, email, password_hash, is_agent) VALUES (?1, ?2, ?3, 'x', ?4)").run(id, name, `${name}@forge.test`, agent ? 1 : 0);
    if (agent) db.query("INSERT INTO agent (user_id, roles) VALUES (?1, 'builder')").run(id);
    return id;
  };
  const owner = user("owner", false);
  const person = user("pat", false);
  const repoId = nid("r");
  db.query("INSERT INTO repo (id, owner_id, name, visibility, autonomy, autonomy_by) VALUES (?1, ?2, 'app', 'public', 'autonomous', ?2)").run(repoId, owner);
  const builders: Record<string, string> = {};
  for (const name of names) {
    builders[name] = user(name, true);
    db.query("INSERT INTO repo_crew (repo_id, user_id, role) VALUES (?1, ?2, 'builder')").run(repoId, builders[name]);
  }
  let number = 0;
  return {
    app,
    db,
    repoId,
    owner,
    builders,
    person,
    user,
    pull(o) {
      const id = nid("i");
      const head = o.head ?? `head${o.number}`;
      number = Math.max(number, o.number);
      db.query("INSERT INTO issue (id, repo_id, number, kind, title, author_id, assignee_id, created_at, updated_at) VALUES (?1, ?2, ?3, 'pull', ?4, ?5, ?6, ?7, ?7)").run(
        id, repoId, o.number, `pull ${o.number}`, o.author, o.assignee ?? null, o.createdAt,
      );
      db.query("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id) VALUES (?1, 'main', ?2, 'base', ?3, ?4)").run(
        id, `branch-${o.number}`, head, o.headRepoId ?? null,
      );
      if (o.approved !== false) {
        db.query("INSERT INTO review (id, issue_id, author_id, state, commit_oid, created_at) VALUES (?1, ?2, ?3, 'approved', ?4, ?5)").run(nid("v"), id, owner, head, o.createdAt);
      }
      return id;
    },
    run(o) {
      db.query("INSERT INTO run (id, repo_id, kind, issue_id, commit_oid, state, reason, created_at, started_at, finished_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?8)").run(
        nid("n"), repoId, o.kind, o.pull, o.head, o.state, o.reason ?? "", o.at,
      );
    },
    hold(pull, by, at, untilGreen = false) {
      db.query("INSERT INTO pull_hold (id, issue_id, held_by, why, held_at, until_green) VALUES (?1, ?2, ?3, 'wait', ?4, ?5)").run(nid("h"), pull, by, at, untilGreen ? 1 : 0);
    },
  };
}

/** One keeper run over the seed. */
export async function runKeeper(s: Seed, now: Date, deps: import("../../src/maintain/duties/flow_keeper.ts").Deps & { withApp?: boolean } = {}) {
  const { flowKeeper } = await import("../../src/maintain/duties/flow_keeper.ts");
  const { withApp, ...rest } = deps;
  return flowKeeper({ builders: () => undefined, ...(rest.vantages === undefined && !withApp ? { vantages: () => [] } : {}), ...rest }).run({ db: s.db, bus: s.app.bus, now, ...(withApp ? { app: s.app } : {}) });
}
