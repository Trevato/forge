/**
 * An open pull's page reads everything before it renders (#8389): each read
 * is its own Server-Timing phase, named in order, and `render` is what is
 * left — for an open pull with a check, a look and a preview record. The
 * 20 ms budget is read from production's Server-Timing, not asserted here:
 * a wall-clock bound on a shared machine flakes.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { enableApp } from "../src/actions/apps.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { getAppByRepo } from "../src/core/apps.ts";
import { recordLook } from "../src/core/looks.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { PULL_PAGE_PHASES } from "./helpers/pull-phases.ts";
import { PNG } from "./helpers/studio.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let cookie = "";
let number = 0;
const cells = process.env["FORGE_CELLS"];

beforeAll(async () => {
  process.env["FORGE_CELLS"] = "off";
  dataDir = await mkdtemp(join(tmpdir(), "forge-pull-page-phases-"));
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
  for (const [branch, file] of [[undefined, "forge.json"], ["topic", "t.txt"]] as const) {
    const done = await commitToBranch(app, alice, repo.value, {
      ...(branch === undefined ? {} : { branch }),
      message: "change",
      files: [{ path: file, content: file === "forge.json" ? '{"run":"bun run x.ts"}' : "x" }],
    });
    if (!done.ok) throw new Error(JSON.stringify(done.error));
  }
  const enabled = await enableApp(app, alice, repo.value, { slug: "r" });
  if (!enabled.ok) throw new Error(String(enabled.error));
  const pull = await openPull(app, alice, repo.value, {
    title: "a change to look at",
    body: "",
    baseBranch: "main",
    headBranch: "topic",
  });
  if (!pull.ok) throw new Error(JSON.stringify(pull.error));
  number = pull.value.number;
  const env = `pull-${number}`;
  for (const kind of ["check", "deploy"] as const) {
    const run = createRun(app.db, {
      repoId: repo.value.id,
      kind,
      issueId: pull.value.id,
      env,
      commitOid: pull.value.headOid,
      reason: "pull",
    });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, { state: "ok", summary: `${kind} passed` });
  }
  const record = getAppByRepo(app.db, repo.value.id)!;
  const rel = join("looks", record.id, `${env}-desktop.png`);
  mkdirSync(dirname(join(dataDir, rel)), { recursive: true });
  writeFileSync(join(dataDir, rel), PNG);
  recordLook(app.db, { appId: record.id, env, commitOid: pull.value.headOid, kind: "desktop", path: rel });
});

afterAll(async () => {
  await servers.stop();
  app.close();
  if (cells === undefined) delete process.env["FORGE_CELLS"];
  else process.env["FORGE_CELLS"] = cells;
  await rm(dataDir, { recursive: true, force: true });
});

async function timed(): Promise<{ names: string[]; ms: (n: string) => number; body: string }> {
  const res = await fetch(`${servers.url}/alice/r/pulls/${number}`, { headers: { cookie } });
  expect(res.status).toBe(200);
  const body = await res.text();
  const parts = (res.headers.get("server-timing") ?? "").split(", ");
  const all = parts.map((p) => p.split(";")[0]!);
  const ms = (n: string) => Number(parts[all.indexOf(n)]!.match(/dur=([\d.]+)/)![1]);
  return { names: all.slice(all.indexOf("app") + 1), ms, body };
}

test("an open pull's page names each of its reads as a phase before render", async () => {
  const got = await timed();
  expect(got.names).toEqual([...PULL_PAGE_PHASES]);
  // What was seeded is drawn: the look, the preview and the check.
  expect(got.body).toContain("<h2>Look</h2>");
  expect(got.body).toContain("<h2>Preview</h2>");
  expect(got.body).toContain('data-word="look"');
  const sum = got.names.reduce((t, n) => t + got.ms(n), 0);
  expect(sum).toBeLessThanOrEqual(got.ms("app") + 0.1 * got.names.length);
});
