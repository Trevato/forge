/** An archived repository stops raising the viewer's affinity; waking it brings it back. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { moveArchived, type Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { affinityFor } from "../src/feed/affinity.ts";

describe("feed affinity and archive", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let old: Repo;
  let live: Repo;
  const NOW = Date.parse("2026-01-01T00:00:00Z");

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-affinity-archived-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const r = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      allowReserved: true,
      email: "alice@f.dev",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!r.ok) throw new Error(r.error);
    alice = r.value;
    const mk = async (name: string) => {
      const c = await createRepo(app, alice, { name, visibility: "public" });
      if (!c.ok) throw new Error(`repo: ${JSON.stringify(c)}`);
      return c.value;
    };
    old = await mk("old");
    live = await mk("live");
  });
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("archiving drops a repository from the score, waking restores it", async () => {
    const score = (r: Repo) => affinityFor(app.db, alice, NOW).app(r.id).score;
    expect(score(old)).toBeGreaterThan(0);
    expect(score(live)).toBeGreaterThan(0);

    expect(moveArchived(app.db, old.id, true)).toBe(true);
    expect(score(old)).toBe(0);
    expect(score(live)).toBeGreaterThan(0);

    const page = await fetch(`http://localhost:${servers.port}/alice/old`);
    expect(page.status).toBe(200);

    expect(moveArchived(app.db, old.id, false)).toBe(true);
    expect(score(old)).toBeGreaterThan(0);
  });
});
