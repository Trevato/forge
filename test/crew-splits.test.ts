import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import {
  agentSplits,
  claimRun,
  createRun,
  finishRun,
  noteRunProgress,
} from "../src/core/runs.ts";
import { promptVersion } from "../src/crew/brief.ts";
import { getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { adminCookie } from "./helpers/admin.ts";

describe("the scorecard splits by model and prompt version", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let cookie = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-splits-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    cookie = await adminCookie(app, {
      username: "ada",
      email: "ada@forge.example",
      password: "analytical-engine",
    });
    const headers = { cookie, "content-type": "application/json" };
    const repo = (await fetch(`${servers.url}/api/v1/repos`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "hello", visibility: "public" }),
    }).then((r) => r.json())) as { id: string };
    await fetch(`${servers.url}/api/v1/agents`, {
      method: "POST",
      headers,
      body: JSON.stringify({ username: "smith" }),
    });
    const agentId = getUserByName(app.db, "smith")!.id;
    const agent = (brief: string) =>
      ({ brief, model: "" }) as Parameters<typeof promptVersion>[0];
    for (const [brief, model] of [
      ["Be terse.", "claude-sonnet-5-5"],
      ["Be terse.", "claude-sonnet-5-5"],
      ["Be thorough.", "claude-opus-5-5"],
    ] as const) {
      const run = createRun(app.db, {
        repoId: repo.id,
        kind: "agent",
        actorId: agentId,
      });
      claimRun(app.db, run.id);
      noteRunProgress(app.db, run.id, {
        model,
        promptVersion: promptVersion(agent(brief)),
      });
      finishRun(app.db, run.id, { state: "ok", summary: "", costUsd: 0.1 });
    }
    // A run from before the recording: both keys empty.
    const old = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      actorId: agentId,
    });
    claimRun(app.db, old.id);
    finishRun(app.db, old.id, { state: "ok", summary: "", costUsd: 0.1 });
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("two briefs are two prompt versions; one brief is one", () => {
    const a = { brief: "x", model: "" } as Parameters<typeof promptVersion>[0];
    expect(promptVersion(a)).toBe(promptVersion({ ...a }));
    expect(promptVersion(a)).not.toBe(promptVersion({ ...a, brief: "y" }));
    const versions = agentSplits(app.db, "prompt_version");
    expect(versions.map((v) => v.runs)).toEqual([2, 1, 1]);
  });

  test("runs split by model", () => {
    const models = agentSplits(app.db, "model");
    expect(models.map((m) => [m.key, m.runs])).toEqual([
      ["claude-sonnet-5-5", 2],
      ["", 1],
      ["claude-opus-5-5", 1],
    ]);
  });

  test("the crew page shows both cuts", async () => {
    const page = await fetch(`${servers.url}/settings/crew`, {
      headers: { cookie },
    }).then((r) => r.text());
    expect(page).toContain("Per model");
    expect(page).toContain("Per prompt version");
    expect(page).toContain("claude-opus-5-5");
    // The shipped state of every existing run: the empty key.
    expect(page).toContain(`<td class="mono"><span class="muted">default</span></td>`);
    expect(page).toContain(`<td class="mono"><span class="muted">not recorded</span></td>`);
  });
});
