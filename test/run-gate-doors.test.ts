/**
 * The closed side of the run gate as one table: every door a crew-run token
 * must not open answers 404 `not_found`, the same as a repository it cannot
 * see, and the parent repository is read-only (#6853).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo, forkRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import type { Repo } from "../src/core/repos.ts";
import { mintRunToken } from "../src/core/run_token.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const EXPIRES = "2999-01-01T00:00:00.000Z";

describe("the run gate's closed doors", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let parent: Repo;
  let fork: Repo;
  let run: string;
  let personal: string;

  const call = (path: string, method = "GET", token = run, body?: unknown) =>
    fetch(`${servers.url}${path}`, {
      method,
      redirect: "manual",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(body ?? {}),
    });

  const make = async (name: string, visibility: "public" | "private") => {
    const made = await createRepo(app, alice, { name, visibility });
    if (!made.ok) throw new Error(String(made.error));
    const seeded = await commitToBranch(app, alice, made.value, {
      branch: "main",
      message: "Start",
      files: [{ path: "README.md", content: `${name} unique-${name}\n` }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    return made.value;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-run-doors-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    servers = await serve(app);
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    alice = made.value;
    parent = await make("upstream", "public");
    await make("vault", "private");
    await make("mine", "public");
    const forked = await forkRepo(app, alice, parent, "upstream-work");
    if (!forked.ok) throw new Error(String(forked.error));
    fork = forked.value;
    personal = createToken(app.db, alice.id, "personal", "rw").token;
    // A run on the fork: its parent is `upstream`, read-only.
    run = mintRunToken(app.db, alice.id, "doors", { repoId: fork.id, forkId: fork.id }, EXPIRES).token;
  });

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  const closed: [string, string][] = [
    ["GET", "/api/v1/user"],
    ["GET", "/api/v1/user/keys"],
    ["GET", "/api/v1/tokens"],
    ["POST", "/api/v1/tokens"],
    ["DELETE", "/api/v1/tokens/1"],
    ["GET", "/api/v1/secrets/alice"],
    ["PUT", "/api/v1/secrets/alice/KEY"],
    ["DELETE", "/api/v1/secrets/alice/KEY"],
    ["GET", "/api/v1/admin/settings"],
    ["GET", "/api/v1/admin/accounts"],
    ["POST", "/api/v1/admin/accounts/alice/suspend"],
    ["GET", "/api/v1/admin/limits"],
    ["POST", "/mcp"],
    ["GET", "/mcp"],
    ["GET", "/"],
    ["GET", "/explore"],
    ["GET", "/alice/upstream"],
    ["GET", "/alice/vault"],
    ["GET", "/api/v1/repos/alice/vault"],
    ["GET", "/api/v1/repos/alice/vault/issues"],
    ["POST", "/api/v1/repos/alice/vault/issues"],
    ["GET", "/api/v1/repos/alice/mine"],
    ["POST", "/api/v1/repos/alice/mine/issues"],
    ["GET", "/api/v1/repos/alice/nobody-here"],
    ["POST", "/api/v1/repos"],
  ];

  test("each closed door answers 404 not_found, as an unseen repository does", async () => {
    const unseen = await (await call("/api/v1/repos/alice/nobody-here")).text();
    expect(JSON.parse(unseen).error).toBe("not_found");
    for (const [method, path] of closed) {
      const res = await call(path, method);
      const body = await res.text();
      expect([method, path, res.status]).toEqual([method, path, 404]);
      expect([method, path, JSON.parse(body).error]).toEqual([method, path, "not_found"]);
    }
    // The doors exist for the crew member's own token.
    expect((await call("/api/v1/user", "GET", personal)).status).toBe(200);
    expect((await call("/api/v1/repos/alice/vault", "GET", personal)).status).toBe(200);
  });

  test("the parent reads; writing under it is 404 and changes nothing", async () => {
    expect((await call("/api/v1/repos/alice/upstream")).status).toBe(200);
    expect((await call("/api/v1/repos/alice/upstream/issues")).status).toBe(200);
    const base = "/api/v1/repos/alice/upstream";
    const writes: [string, string, unknown][] = [
      ["POST", `${base}/issues`, { title: "from the run" }],
      ["PATCH", `${base}/issues/1`, { title: "renamed by the run" }],
      ["POST", `${base}/issues/1/comments`, { body: "from the run" }],
      ["PATCH", base, { description: "changed by the run" }],
      ["DELETE", base, undefined],
    ];
    // The doors are real routes: the crew member's own token opens them.
    const made = await call(`${base}/issues`, "POST", personal, { title: "Seed" });
    expect(made.status).toBe(201);
    const state = () => [
      app.db.query("SELECT COUNT(*) AS n, MAX(title) AS t FROM issue").get(),
      app.db.query("SELECT COUNT(*) AS n FROM comment").get(),
      app.db.query("SELECT COUNT(*) AS n, MAX(description) AS d FROM repo").get(),
    ];
    const before = state();
    for (const [method, path, body] of writes) {
      const res = await call(path, method, run, body);
      expect([method, path, res.status, ((await res.json()) as { error: string }).error]).toEqual([method, path, 404, "not_found"]);
    }
    expect(state()).toEqual(before);
    expect((await call(`${base}/issues/1`, "PATCH", personal, { title: "Renamed" })).status).toBe(200);
    expect((await call(`${base}/issues/1/comments`, "POST", personal, { body: "noted" })).status).toBe(201);
    // The repository itself answers its owner, not 404 (what it says to a change is its own business).
    expect((await call(base, "PATCH", personal, { description: "Changed" })).status).not.toBe(404);
    expect(state()).not.toEqual(before);
    expect((await call(base)).status).toBe(200);
  });

  test("here, search, explore and openapi.json answer, and search names nothing outside the two repositories", async () => {
    for (const path of ["/api/v1/here?path=/alice/upstream-work", "/api/v1/search?q=upstream", "/api/v1/explore"])
      expect((await call(path)).status).toBe(200);
    expect((await call("/api/v1/openapi.json")).status).toBe(308);
    for (const q of ["vault", "mine", "unique-vault", "unique-mine"]) {
      const res = await call(`/api/v1/search?q=${q}`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).not.toContain("vault");
      expect(body).not.toContain("alice/mine");
    }
    const hit = await (await call("/api/v1/search?q=unique-upstream")).text();
    expect(hit).toContain("upstream");
  });
});
