/** A run-scoped search names each part once, however many repositories it spans (#7112). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchWithin, type SearchPhase } from "../src/actions/search.ts";
import { createApp } from "../src/app.ts";
import { getRepo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir = "";
let app: ReturnType<typeof createApp>;
let servers: Awaited<ReturnType<typeof serve>>;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-search-within-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!made.ok) throw new Error(made.error);
  const bearer = createToken(app.db, made.value.id, "t", "admin").token;
  for (const name of ["one", "two"]) {
    await fetch(`${servers.url}/api/v1/repos`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ name, visibility: "public" }),
    });
  }
}, 60_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("searchWithin over two readable repositories reports repos, issues and code once each", async () => {
  const repos = ["one", "two"].map((n) => getRepo(app.db, "alice", n)!);
  expect(repos.every((r) => r !== undefined)).toBe(true);
  const named: SearchPhase[] = [];
  await searchWithin(app, undefined, repos, { q: "one", phase: (name) => named.push(name) });
  expect(named.sort()).toEqual(["code", "issues", "repos"]);
});
