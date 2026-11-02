/** An empty repository's activity and waves feeds say when the process started, not 1970, and the same twice. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("empty feeds", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-empty-feeds-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const u = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@f.dev", password: "a-good-passphrase", adminIfFirst: true });
    if (!u.ok) throw new Error(u.error);
    const made = await createRepo(app, u.value, { name: "r", visibility: "public", description: "d" });
    if (!made.ok) throw new Error(String(made.error));
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  for (const feed of ["activity.atom", "waves.atom"]) {
    test(`${feed} is dated by the process start`, async () => {
      const get = async () =>
        (await (await fetch(`${servers.url}/alice/r/${feed}`)).text()).match(/<updated>([^<]*)<\/updated>/)![1]!;
      const first = await get();
      expect(first).not.toContain("1970-01-01");
      expect(Date.parse(first)).toBeGreaterThan(Date.parse("2026-01-01"));
      expect(await get()).toBe(first);
    });
  }
});
