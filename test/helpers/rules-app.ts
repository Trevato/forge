/** An app with one repo owned by alice, for the rule watcher's tests (#7560). */
import { afterAll, beforeAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../../src/actions/repos.ts";
import { createApp, type App } from "../../src/app.ts";
import { createUser } from "../../src/core/users.ts";
import { quietLogs } from "./globals.ts";

export interface RulesWorld {
  app: App;
  repoId: string;
  ownerId: string;
  repos: Map<string, { id: string; ownerId: string }>;
  titles(): string[];
}

export function rulesWorld(): RulesWorld {
  quietLogs();
  let dir = "";
  const world = {} as RulesWorld;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "rules-"));
    world.app = createApp({ dataDir: dir, port: 0, host: "forge.test" });
    const u = await createUser(world.app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    if (!u.ok) throw new Error(u.error);
    const made = await createRepo(world.app, u.value, { name: "rules", visibility: "public" });
    if (!made.ok) throw new Error("repo");
    world.repoId = made.value.id;
    world.ownerId = u.value.id;
    world.repos = new Map([[made.value.id, { id: made.value.id, ownerId: u.value.id }]]);
    world.titles = () => world.app.db.query<{ title: string }, [string]>("SELECT title FROM issue WHERE repo_id = ?1 AND kind = 'issue'").all(world.repoId).map((r) => r.title);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return world;
}
