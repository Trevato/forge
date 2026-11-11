import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createIssue } from "../src/core/issues.ts";
import { createRepo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

// Issues and pulls share one number space: a read of the other kind's URL lands on it.
describe("thread kind redirect", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-kind-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const user = await createUser(app.db, { origin: "seed", trusted: true, username: "o", email: "o@f.dev", password: "kind-redirect-pass" });
    if (!user.ok) throw new Error("user");
    for (const [name, visibility] of [["r", "public"], ["p", "private"]] as const) {
      const repo = await createRepo(app.db, app.reposRoot, { ownerId: user.value.id, name, visibility });
      if (!repo.ok) throw new Error("repo");
      createIssue(app.db, { repoId: repo.value.id, authorId: user.value.id, title: "an issue" });
      createIssue(app.db, { repoId: repo.value.id, authorId: user.value.id, title: "a pull", kind: "pull" });
    }
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("GET /issues/N for a pull redirects to /pulls/N, keeping the query", async () => {
    const res = await fetch(`${base}/o/r/issues/2?x=1`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/o/r/pulls/2?x=1");
  });

  test("GET /pulls/N for an issue redirects to /issues/N", async () => {
    const res = await fetch(`${base}/o/r/pulls/1`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/o/r/issues/1");
  });

  test("a private repo's item still 404s for a stranger", async () => {
    for (const path of ["/o/p/issues/2", "/o/p/pulls/1"]) {
      const res = await fetch(`${base}${path}`, { redirect: "manual" });
      expect(res.status).toBe(404);
    }
  });

  test("a POST to the other kind's URL is not redirected", async () => {
    const res = await fetch(`${base}/o/r/issues/2/comments`, { method: "POST", body: new URLSearchParams({ body: "hi" }), redirect: "manual" });
    expect(res.status).not.toBe(302);
  });
});
