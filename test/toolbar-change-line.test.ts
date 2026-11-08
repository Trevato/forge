/** A preview's toolbar page says what its pull changed and where its check stands (#4221). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { getPull } from "../src/core/pulls.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { statReads } from "../src/web/studio/toolbar.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let cookie = "";
let repoId = "";
let aliceId = "";
let aliceUser: Parameters<typeof newApp>[1];
let repoRow: Parameters<typeof commitToBranch>[2];
const numbers: number[] = [];
const cells = process.env["FORGE_CELLS"];

beforeAll(async () => {
  process.env["FORGE_CELLS"] = "off";
  dataDir = await mkdtemp(join(tmpdir(), "forge-toolbar-change-"));
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
  aliceId = alice.id;
  aliceUser = alice;
  cookie = `forge_session=${createSession(app.db, alice.id).token}`;
  const repo = await newApp(app, alice, { name: "notes", description: "x", visibility: "public" });
  if (!repo.ok) throw new Error(String(repo.error));
  repoId = repo.value.repo.id;
  repoRow = repo.value.repo;
  const base = await commitToBranch(app, alice, repo.value.repo, {
    message: "base",
    files: [{ path: "forge.json", content: "{}" }],
  });
  if (!base.ok) throw new Error(JSON.stringify(base.error));
  for (const name of ["green", "red", "none"]) {
    const done = await commitToBranch(app, alice, repo.value.repo, {
      branch: name,
      message: name,
      files: [
        { path: `${name}.txt`, content: "a\nb\nc\n" },
        { path: `${name}2.txt`, content: "x\n" },
      ],
    });
    if (!done.ok) throw new Error(JSON.stringify(done.error));
    const pull = await openPull(app, alice, repo.value.repo, {
      title: name,
      body: "",
      baseBranch: "main",
      headBranch: name,
    });
    if (!pull.ok) throw new Error(JSON.stringify(pull.error));
    numbers.push(pull.value.number);
  }
}, 60_000);

afterAll(async () => {
  await servers.stop();
  app.close();
  if (cells === undefined) delete process.env["FORGE_CELLS"];
  else process.env["FORGE_CELLS"] = cells;
  await rm(dataDir, { recursive: true, force: true });
});

const read = (env: string, c = cookie) =>
  fetch(`${servers.url}/alice/notes/toolbar?env=${env}`, { headers: c ? { cookie: c } : {} });

function check(number: number, state: "ok" | "failed"): string {
  const pull = getPull(app.db, repoId, number)!;
  const run = createRun(app.db, { repoId, kind: "check", issueId: pull.id, commitOid: pull.headOid, actorId: aliceId });
  claimRun(app.db, run.id);
  finishRun(app.db, run.id, { state, summary: "" });
  return run.id;
}

test("a green check: totals link to Files, the badge to the log", async () => {
  const run = check(numbers[0]!, "ok");
  const res = await read(`pull-${numbers[0]}`);
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).toContain('class="change-line"');
  expect(text).toContain(`href="/alice/notes/pulls/${numbers[0]}/files"`);
  expect(text).toContain("<strong>2</strong>");
  expect(text).toContain('<span class="add">+4</span>');
  expect(text).toContain('<span class="del">−0</span>');
  expect(text).toContain(`href="/alice/notes/runs/${run}"`);
  expect(text).toContain("Passed");
});

test("a red check", async () => {
  const run = check(numbers[1]!, "failed");
  const text = await (await read(`pull-${numbers[1]}`)).text();
  expect(text).toContain(`href="/alice/notes/runs/${run}"`);
  expect(text).toContain("Failed");
});

test("no check, and git is asked once per head and base", async () => {
  const text = await (await read(`pull-${numbers[2]}`)).text();
  expect(text).toContain("No check");
  const before = statReads.count;
  await (await read(`pull-${numbers[2]}`)).text();
  expect(statReads.count).toBe(before);
  // The base moves: the totals are read again, not served stale.
  const moved = await commitToBranch(app, aliceUser, repoRow, {
    message: "base moves",
    files: [{ path: "later.txt", content: "z\n" }],
  });
  if (!moved.ok) throw new Error(JSON.stringify(moved.error));
  await (await read(`pull-${numbers[2]}`)).text();
  expect(statReads.count).toBe(before + 1);
});

test("when git cannot give the totals, none are shown", async () => {
  const pull = getPull(app.db, repoId, numbers[2]!)!;
  app.db.query("UPDATE pull SET head_oid = ?1 WHERE issue_id = ?2").run("0".repeat(40), pull.id);
  try {
    const text = await (await read(`pull-${numbers[2]}`)).text();
    expect(text).toContain('class="change-line"');
    expect(text).not.toContain("0</strong> files");
    expect(text).not.toContain('class="add"');
  } finally {
    app.db.query("UPDATE pull SET head_oid = ?1 WHERE issue_id = ?2").run(pull.headOid, pull.id);
  }
});

test("signed out sees it too; production is unchanged", async () => {
  expect(await (await read(`pull-${numbers[0]}`, "")).text()).toContain("change-line");
  const prod = await (await read("production")).text();
  expect(prod).not.toContain('class="change-line"');
});

test("a pull the viewer may not see is a 404", async () => {
  expect((await read("pull-9999")).status).toBe(404);
});

test("lists changed files with anchors, counts, escaping, and a cut-off", async () => {
  const files = Array.from({ length: 12 }, (_, i) => ({ path: `d/f${String(i).padStart(2, "0")}.txt`, content: "a\n" }));
  files.push({ path: "d/<b>x.txt", content: "a\nb\n" });
  const done = await commitToBranch(app, aliceUser, repoRow, { branch: "many", message: "many", files });
  if (!done.ok) throw new Error(JSON.stringify(done.error));
  const pull = await openPull(app, aliceUser, repoRow, { title: "many", body: "", baseBranch: "main", headBranch: "many" });
  if (!pull.ok) throw new Error(JSON.stringify(pull.error));
  const n = pull.value.number;
  const text = await (await read(`pull-${n}`)).text();
  expect(text).toContain('class="change-files"');
  expect(text).toContain(`href="/alice/notes/pulls/${n}/files#d-d-f00-txt"`);
  expect(text).toContain('<span class="add" aria-label="1 added">+1</span>');
  expect(text).not.toContain("<b>x");
  expect(text).toContain("d/&lt;b&gt;x.txt");
  const block = /<ul class="change-files"[\s\S]*?<\/ul>/.exec(text)![0];
  expect(block).toContain('aria-label="Files this pull changed"');
  expect(block).toContain('aria-label="2 added"');
  const listed = block.match(/<li>/g)!.length;
  expect(listed).toBe(11);
  expect(text).toContain("and 3 more");
  expect(text).toContain(`href="/alice/notes/pulls/${n}/files">and 3 more`);
  const before = statReads.count;
  await (await read(`pull-${n}`)).text();
  expect(statReads.count).toBe(before);
  expect(await (await read("production")).text()).not.toContain("change-files");
});
