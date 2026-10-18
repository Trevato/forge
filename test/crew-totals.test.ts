import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import {
  agentTotals,
  claimRun,
  createRun,
  finishRun,
} from "../src/core/runs.ts";
import { getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { adminCookie } from "./helpers/admin.ts";

describe("what an agent has done, in totals", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let cookie = "";
  let repoId = "";
  let agentId = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-totals-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    cookie = await adminCookie(app, {
      username: "ada",
      email: "ada@forge.example",
      password: "analytical-engine",
    });
    const headers = { cookie, "content-type": "application/json" };
    const repo = (await fetch(`${base}/api/v1/repos`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "hello", visibility: "public" }),
    }).then((r) => r.json())) as { id: string };
    repoId = repo.id;
    await fetch(`${base}/api/v1/agents`, {
      method: "POST",
      headers,
      body: JSON.stringify({ username: "smith" }),
    });
    agentId = getUserByName(app.db, "smith")!.id;
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("nothing yet is a quiet dash on the crew page", async () => {
    expect(agentTotals(app.db).get(agentId)).toBeUndefined();
    const page = await fetch(`${base}/settings/crew`, {
      headers: { cookie },
    }).then((r) => r.text());
    expect(page).toContain("<th>Spent</th>");
    // What says who does good work: the cost of a landed change, and how
    // much of the effort was going again.
    expect(page).toContain("<th>Per landed</th>");
    expect(page).toContain(`<td class="num muted">—</td>`);
  });

  test("runs, outcomes, spend and mean time add up", async () => {
    for (const [state, cost] of [
      ["ok", 0.25],
      ["ok", 0.17],
      ["failed", 0.05],
    ] as const) {
      const run = createRun(app.db, {
        repoId,
        kind: "agent",
        actorId: agentId,
      });
      claimRun(app.db, run.id);
      finishRun(app.db, run.id, { state, summary: "done", costUsd: cost });
    }
    // A deploy run is not the agent's work, whoever started it.
    const deploy = createRun(app.db, {
      repoId,
      kind: "deploy",
      actorId: agentId,
    });
    claimRun(app.db, deploy.id);
    finishRun(app.db, deploy.id, { state: "ok", summary: "up", costUsd: 0 });

    const totals = agentTotals(app.db).get(agentId)!;
    expect(totals.runs).toBe(3);
    expect(totals.ok).toBe(2);
    expect(totals.failed).toBe(1);
    expect(totals.spentUsd).toBeCloseTo(0.47, 5);
    expect(totals.meanSeconds).not.toBeNull();

    const page = await fetch(`${base}/settings/crew`, {
      headers: { cookie },
    }).then((r) => r.text());
    expect(page).toContain("$0.47");
    expect(page).toContain("2 ok");
    expect(page).toContain("1 failed");
  });
});
