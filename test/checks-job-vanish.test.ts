/**
 * A check Job that vanishes (#1593): the run is interrupted, never hung, and
 * queued again once; a second loss fails it. Through a stand-in kube client.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { startChecks, type ChecksHandle } from "../src/checks/service.ts";
import { VANISHED_SUMMARY, listRuns } from "../src/core/runs.ts";
import { createUser } from "../src/core/users.ts";
import type { Repo } from "../src/core/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { runJob } from "../src/cluster/jobs.ts";

const cred = { server: "https://k", token: "t", namespace: "forge" };
const spec = { name: "check-x", image: "oven/bun:1", command: ["true"] };

describe("runJob", () => {
  test("a Job that is gone from the API throws instead of polling forever", async () => {
    const fetch = async (_u: string, init: RequestInit) =>
      init.method === "GET" ? new Response("{}", { status: 404 }) : Response.json({});
    await expect(runJob(spec, { fetch: fetch as never, credentials: cred, pollMs: 1 })).rejects.toThrow("gone");
  });
  test("a failed Job whose pod was evicted throws", async () => {
    const fetch = async (u: string, init: RequestInit) => {
      if (init.method !== "GET") return Response.json({});
      if (new URL(u).pathname.endsWith("/pods"))
        return Response.json({ items: [{ metadata: { name: "p" }, status: { reason: "Evicted" } }] });
      return Response.json({ status: { failed: 1 } });
    };
    await expect(runJob(spec, { fetch: fetch as never, credentials: cred, pollMs: 1 })).rejects.toThrow("evicted");
  });
});

describe("a vanished check Job", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let checks: ChecksHandle;
  let repo: Repo;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-vanish-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const fetch = async (_u: string, init: RequestInit) =>
      init.method === "GET" ? new Response("{}", { status: 404 }) : Response.json({});
    checks = startChecks(app, {
      forgeUrl: servers.url,
      concurrency: 1,
      placement: { mode: "job", image: "oven/bun:1", claim: "checks-root", nodeSelector: {}, tolerations: [] },
      job: { fetch: fetch as never, credentials: cred, pollMs: 1 },
    });
    const a = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    const made = await createRepo(app, a.value, { name: "lib", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const c = await commitToBranch(app, a.value, repo, {
      message: "Declare a check",
      files: [{ path: "forge.json", content: '{"check": {"run": "exit 0", "install": ""}}\n' }],
    });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
  });
  afterAll(async () => {
    await checks.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("is interrupted and queued again once; the second loss fails", async () => {
    const deadline = Date.now() + 30_000;
    let runs: ReturnType<typeof listRuns> = [];
    while (Date.now() < deadline) {
      runs = listRuns(app.db, repo.id, { kind: "check", limit: 50 });
      if (runs.some((r) => r.state === "failed")) break;
      await Bun.sleep(50);
    }
    const first = runs.find((r) => r.attempt === 0)!;
    const second = runs.find((r) => r.attempt === 1)!;
    expect(first.state).toBe("cancelled");
    expect(first.summary).toBe(VANISHED_SUMMARY);
    expect(second.state).toBe("failed");
    expect(second.summary).toContain("vanished");
    expect(runs.length).toBe(2);
  });
});
