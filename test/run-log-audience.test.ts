/**
 * A public repository's run is public in its summary and private in its log
 * (#1075): the log is the agent's transcript — what it ran, read and
 * concluded — so only the repository's writers and crew read it, on the run
 * page, the API, and the live tails beside it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppRecord } from "../src/core/apps.ts";
import type { Repo } from "../src/core/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { enableApp } from "../src/actions/apps.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { getAppByRepo } from "../src/core/apps.ts";
import { createAgent } from "../src/actions/crew.ts";
import { addCrew } from "../src/core/agents.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { forgeHttp, type ForgeHttp } from "../src/http/server.ts";
import { appendRunLog } from "../src/runs/log.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const LINE = "R7LOGLINE cat /sandbox/notes.txt";
const SUMMARY = "R7SUMMARY fixed the thing";

let dataDir: string;
let app: App;
let http: ForgeHttp;
let runId: string;
let runtime: AppsRuntime;
let appRecord: AppRecord;
let repoRow: Repo;
let aliceId: string;
const token: Record<string, string> = {};

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

async function get(path: string, who?: string) {
  const res = await http.handle(new Request(`http://forge.test${path}`, {
    headers: {
      cookie: "forge_mode=studio",
      ...(who === undefined ? {} : { authorization: `Bearer ${token[who]}` }),
    },
  }));
  return { status: res.status, text: await res.text() };
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-runlog-"));
  app = createApp({ dataDir, port: 0 });
  http = forgeHttp(app);
  const alice: User = ok(
    await createUser(app.db, {
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    }),
  );
  const mallory = ok(
    await createUser(app.db, {
      trusted: true,
      username: "mallory",
      email: "mallory@forge.local",
      password: "a-good-passphrase",
    }),
  );
  const repo = ok(
    await createRepo(app, alice, { name: "square", visibility: "public" }),
  );
  ok(
    await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "# square\n" }],
    }),
  );
  repoRow = repo;
  aliceId = alice.id;
  runtime = new AppsRuntime(app, {
    domain: "audience.test",
    scheme: "http",
    publicPort: 0,
    forgeUrl: "http://forge.test",
    concurrency: 1,
  });
  ok(await enableApp(app, alice, repo, { slug: "square" }));
  appRecord = getAppByRepo(app.db, repo.id)!;
  token.alice = createToken(app.db, alice.id, "t", "rw").token;
  token.mallory = createToken(app.db, mallory.id, "t", "rw").token;
  const bot = ok(await createAgent(app, alice, { username: "logbot" }));
  addCrew(app.db, repo.id, bot.user.id, alice.id);
  token.logbot = createToken(app.db, bot.user.id, "t", "rw").token;
  const run = createRun(app.db, {
    repoId: repo.id,
    kind: "agent",
    actorId: alice.id,
    reason: "assigned",
  });
  claimRun(app.db, run.id);
  runId = run.id;
  appendRunLog(dataDir, runId, LINE);
  finishRun(app.db, runId, { state: "ok", summary: SUMMARY });
}, 60_000);

afterAll(async () => {
  await runtime?.stop?.();
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("run log audience", () => {
  test("a stranger reads a public repository's run summary, not its log", async () => {
    for (const who of [undefined, "mallory"]) {
      const api = await get(`/api/v1/repos/alice/square/runs/${runId}`, who);
      expect(api.status).toBe(200);
      expect(api.text).toContain("R7SUMMARY");

      const page = await get(`/alice/square/runs/${runId}`, who);
      expect(page.status).toBe(200);
      expect(page.text).toContain("R7SUMMARY");
      expect(page.text).not.toContain("R7LOGLINE");
      expect(page.text).not.toContain(`/runs/${runId}/log`);

      for (const path of [
        `/api/v1/repos/alice/square/runs/${runId}/log`,
        `/api/v1/repos/alice/square/runs/${runId}/log?follow=1`,
      ]) {
        const log = await get(path, who);
        expect(log.status).toBe(404);
        expect(log.text).not.toContain("R7LOGLINE");
      }
    }
  });

  test("a writer still reads the log, on the API and the page", async () => {
    const log = await get(`/api/v1/repos/alice/square/runs/${runId}/log`, "alice");
    expect(log.status).toBe(200);
    expect(log.text).toContain("R7LOGLINE");
    const page = await get(`/alice/square/runs/${runId}`, "alice");
    expect(page.text).toContain("R7LOGLINE");
  });

  test("an agent on the crew reads the log without a write grant", async () => {
    for (const path of [
      `/api/v1/repos/alice/square/runs/${runId}/log`,
      `/api/v1/repos/alice/square/runs/${runId}/log?follow=1`,
    ]) {
      const log = await get(path, "logbot");
      expect(log.status).toBe(200);
      expect(log.text).toContain("R7LOGLINE");
    }
    const page = await get(`/alice/square/runs/${runId}`, "logbot");
    expect(page.text).toContain("R7LOGLINE");
  });

  const putEnv = (slot: Record<string, unknown>): void => {
    (runtime as unknown as { envs: Map<string, unknown> }).envs.set(
      `${appRecord.id}/production`,
      { app: appRecord, env: "production", chain: Promise.resolve(), restarts: [], ...slot },
    );
  };

  test("a deploying production's output is a writer's, on the app page", async () => {
    const deploy = createRun(app.db, {
      repoId: repoRow.id,
      kind: "deploy",
      env: "production",
      commitOid: "f00dcafe",
      reason: "boot",
    });
    claimRun(app.db, deploy.id);
    appendRunLog(dataDir, deploy.id, "R7DEPLOYLINE install deps");
    putEnv({
      deploying: {
        run: { id: deploy.id, commitOid: "f00dcafe" },
        abort: new AbortController(),
      },
    });
    for (const who of [undefined, "mallory"]) {
      const page = await get("/alice/square", who);
      expect(page.status).toBe(200);
      expect(page.text).not.toContain('id="app-run-tail"');
      expect(page.text).not.toContain("R7DEPLOYLINE");
    }
    const mine = await get("/alice/square", "alice");
    expect(mine.text).toContain('id="app-run-tail"');
    expect(mine.text).toContain("R7DEPLOYLINE");
    finishRun(app.db, deploy.id, { state: "ok", summary: "deploy" });
  });

  test("a running agent's tail is a writer's, on the app page", async () => {
    const run = createRun(app.db, {
      repoId: repoRow.id,
      kind: "agent",
      actorId: aliceId,
      reason: "assigned",
    });
    claimRun(app.db, run.id);
    appendRunLog(dataDir, run.id, "R7AGENTLINE reading secrets.txt");
    for (const who of [undefined, "mallory"]) {
      const page = await get("/alice/square", who);
      expect(page.status).toBe(200);
      expect(page.text).not.toContain('id="app-run-tail"');
      expect(page.text).not.toContain("R7AGENTLINE");
    }
    const mine = await get("/alice/square", "alice");
    expect(mine.text).toContain('id="app-run-tail"');
    expect(mine.text).toContain("R7AGENTLINE");
    finishRun(app.db, run.id, { state: "ok", summary: "done" });
  });
});
