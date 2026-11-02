/**
 * GET …/pulls/:number/checks-line (#2280): the checks line alone, gated as
 * the pull page is, carrying a running check's counts from its own log.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createRun } from "../src/core/runs.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { appendRunLog } from "../src/runs/log.ts";
import { quietLogs } from "./helpers/globals.ts";
import { withScripts } from "./helpers/page-script.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let alice: User;
let bob: User;
const numbers: Record<string, number> = {};
let runId = "";
const cells = process.env["FORGE_CELLS"];

const mk = async (username: string, first = false): Promise<User> => {
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username,
    email: `${username}@forge.local`,
    password: "a-good-passphrase",
    adminIfFirst: first,
  });
  if (!made.ok) throw new Error(String(made.error));
  return made.value;
};

const get = (repo: string, user: User): Promise<Response> =>
  fetch(`${servers.url}/alice/${repo}/pulls/${numbers[repo]}/checks-line`, {
    headers: { cookie: `forge_session=${createSession(app.db, user.id).token}` },
  });

beforeAll(async () => {
  process.env["FORGE_CELLS"] = "off";
  dataDir = await mkdtemp(join(tmpdir(), "forge-checks-line-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  alice = await mk("alice", true);
  bob = await mk("bob");
  for (const [name, visibility] of [
    ["open", "public"],
    ["hidden", "private"],
  ] as const) {
    const made = await createRepo(app, alice, { name, visibility });
    if (!made.ok) throw new Error(String(made.error));
    const repo = made.value;
    for (const [branch, file] of [[undefined, "forge.json"], ["topic", "t.txt"]] as const) {
      const done = await commitToBranch(app, alice, repo, {
        ...(branch === undefined ? {} : { branch }),
        message: "change",
        files: [{ path: file, content: file === "forge.json" ? "{}" : "x" }],
      });
      if (!done.ok) throw new Error(JSON.stringify(done.error));
    }
    const pull = await openPull(app, alice, repo, {
      title: name,
      body: "",
      baseBranch: "main",
      headBranch: "topic",
    });
    if (!pull.ok) throw new Error(JSON.stringify(pull.error));
    numbers[name] = pull.value.number;
    if (name === "open") {
      const run = createRun(app.db, {
        repoId: repo.id,
        kind: "check",
        issueId: pull.value.id,
        env: `pull-${pull.value.number}`,
        commitOid: pull.value.headOid,
      });
      app.db.run("UPDATE run SET state = 'running', started_at = ? WHERE id = ?", [
        new Date().toISOString(),
        run.id,
      ]);
      runId = run.id;
    }
  }
});

afterAll(async () => {
  await servers.stop();
  app.close();
  if (cells === undefined) delete process.env["FORGE_CELLS"];
  else process.env["FORGE_CELLS"] = cells;
  await rm(dataDir, { recursive: true, force: true });
});

test("a viewer who cannot read the pull gets 404", async () => {
  expect((await get("hidden", bob)).status).toBe(404);
});

test("a viewer who can gets the line, without counts until the log has them", async () => {
  const res = await get("open", bob);
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).toContain('id="live-checks"');
  expect(text).toContain("Check running");
  expect(text).not.toContain("data-live-every");
  expect(text).not.toContain(" files");
});

test("the counts appear once the run's log holds shard lines", async () => {
  for (const line of [
    "test-shards: 170 files in 4 shards, expected 90s",
    "── shard 1/4: a.test.ts b.test.ts",
    " 500 pass",
    " 0 fail",
    "── shard 1/4 done (exit 0, 3.0s)",
  ])
    appendRunLog(dataDir, runId, line);
  const text = await (await get("open", bob)).text();
  expect(text).toContain("2 of 170 files · 500 passed, 0 failed");
});

test("the page that draws the line also ships the script that drives it", async () => {
  const res = await fetch(`${servers.url}/alice/open/pulls/${numbers["open"]}/files`, {
    headers: { cookie: `forge_session=${createSession(app.db, bob.id).token}` },
  });
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).toContain('id="live-checks"');
  // The line itself carries no beat attribute; the script still knows the mechanism.
  expect(text).not.toMatch(/id="live-checks"[^>]*data-live-every/);
  // liveRegionsJs reads data-live-src and arms the beat; liveClientJs alone does not.
  expect(text).toContain("data-live-src");
  expect(await withScripts(servers.url, text)).toContain("function arm(");
});

test("once the check has passed, the line has no beat, no counts, and reads as passed", async () => {
  app.db.run("UPDATE run SET state = 'ok', finished_at = ? WHERE id = ?", [
    new Date().toISOString(),
    runId,
  ]);
  const text = await (await get("open", bob)).text();
  expect(text).toContain('id="live-checks"');
  expect(text).not.toContain("data-live-every");
  expect(text).not.toContain(" files");
  expect(text).not.toContain("Check running");
  expect(text).toContain("Check passed");
});

test("the change page the owner lands on draws the same live line, with the counts", async () => {
  app.db.run("UPDATE run SET state = 'running', finished_at = NULL WHERE id = ?", [runId]);
  const res = await fetch(`${servers.url}/alice/open/pulls/${numbers["open"]}`, {
    headers: { cookie: `forge_session=${createSession(app.db, alice.id).token}` },
  });
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).toContain('id="live-checks"');
  expect(text).not.toMatch(/id="live-checks"[^>]*data-live-every/);
  expect(text).toContain("2 of 170 files · 500 passed, 0 failed");
  expect(await withScripts(servers.url, text)).toContain("function arm(");
});
