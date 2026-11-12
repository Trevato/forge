/** The check's looks in the API: screens and sideways, without the run page (#9487). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { looksPath } from "../src/checks/looks.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let cookie = "";
let repoId = "";
let pullId = "";
let number = 0;
const cells = process.env["FORGE_CELLS"];
const OID = "b".repeat(40);

const get = async (path: string) => {
  const res = await fetch(`${servers.url}${path}`, { headers: { cookie } });
  return (await res.json()) as any;
};

const writeLooks = (runId: string, size: object) => {
  const path = looksPath(dataDir, runId);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify([
      { look: "phone /x", entries: {}, size },
      { look: "desktop", entries: {} },
    ]),
  );
};

beforeAll(async () => {
  process.env["FORGE_CELLS"] = "off";
  dataDir = await mkdtemp(join(tmpdir(), "forge-check-looks-api-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error(String(made.error));
  const alice = made.value;
  cookie = `forge_session=${createSession(app.db, alice.id).token}`;
  const repo = await createRepo(app, alice, { name: "r", visibility: "public" });
  if (!repo.ok) throw new Error(String(repo.error));
  repoId = repo.value.id;
  for (const [branch, file] of [[undefined, "forge.json"], ["topic", "t.txt"]] as const) {
    const done = await commitToBranch(app, alice, repo.value, {
      ...(branch === undefined ? {} : { branch }),
      message: "change",
      files: [{ path: file, content: file === "forge.json" ? "{}" : "x" }],
    });
    if (!done.ok) throw new Error(JSON.stringify(done.error));
  }
  const pull = await openPull(app, alice, repo.value, { title: "t", body: "", baseBranch: "main", headBranch: "topic" });
  if (!pull.ok) throw new Error(JSON.stringify(pull.error));
  number = pull.value.number;
  pullId = pull.value.id;
});

afterAll(async () => {
  await servers.stop();
  app.close();
  if (cells === undefined) delete process.env["FORGE_CELLS"];
  else process.env["FORGE_CELLS"] = cells;
  await rm(dataDir, { recursive: true, force: true });
});

test("the commit's check carries screens and sideways; [] without a file", async () => {
  const run = createRun(app.db, { repoId, kind: "check", commitOid: OID, env: "main", branch: "main" });
  claimRun(app.db, run.id);
  finishRun(app.db, run.id, { state: "failed", summary: "x" });
  expect((await get(`/api/v1/repos/alice/r/commits/${OID}/check`)).looks).toEqual([]);
  writeLooks(run.id, { scrollWidth: 500, scrollHeight: 2000, innerWidth: 390, innerHeight: 800 });
  const body = await get(`/api/v1/repos/alice/r/commits/${OID}/check`);
  expect(body.runId).toBe(run.id);
  expect(body.looks).toEqual([
    { look: "phone /x", screens: "2.5", sideways: true, size: { scrollWidth: 500, scrollHeight: 2000, innerWidth: 390, innerHeight: 800 } },
    { look: "desktop", screens: "", sideways: false },
  ]);
});

test("the pull's checks carry the same looks beside run", async () => {
  const head = (await get(`/api/v1/repos/alice/r/pulls/${number}/checks`)).head as string;
  expect((await get(`/api/v1/repos/alice/r/pulls/${number}/checks`)).looks).toEqual([]);
  const run = createRun(app.db, { repoId, kind: "check", issueId: pullId, commitOid: head, branch: "topic" });
  expect((await get(`/api/v1/repos/alice/r/pulls/${number}/checks`)).looks).toEqual([]);
  writeLooks(run.id, { scrollWidth: 390, scrollHeight: 1000, innerWidth: 390, innerHeight: 800 });
  const body = await get(`/api/v1/repos/alice/r/pulls/${number}/checks`);
  expect(body.run.id).toBe(run.id);
  expect(body.looks).toEqual([
    { look: "phone /x", screens: "1.3", sideways: false, size: { scrollWidth: 390, scrollHeight: 1000, innerWidth: 390, innerHeight: 800 } },
    { look: "desktop", screens: "", sideways: false },
  ]);
});
