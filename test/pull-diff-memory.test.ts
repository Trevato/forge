/** A second read of an unmoved pull, through `pullDiff` and the API, runs no git (#8160). */
import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { getPull, pullDiff } from "../src/core/pulls.ts";
import { createUser } from "../src/core/users.ts";
import { forgetDiffs } from "../src/git/diff-memory.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let dir: string;
let repoId = "";
let number = 0;
const cells = process.env["FORGE_CELLS"];

beforeAll(async () => {
  process.env["FORGE_CELLS"] = "off";
  dataDir = await mkdtemp(join(tmpdir(), "forge-pull-diff-memory-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!made.ok) throw new Error(String(made.error));
  const alice = made.value;
  const repo = await createRepo(app, alice, { name: "r", visibility: "public" });
  if (!repo.ok) throw new Error(String(repo.error));
  repoId = repo.value.id;
  dir = repoDir(app.reposRoot, "alice", "r");
  const commit = (path: string, content: string, branch?: string) =>
    commitToBranch(app, alice, repo.value, {
      ...(branch === undefined ? {} : { branch }),
      message: "change",
      files: [{ path, content }],
    });
  for (const done of [await commit("a.txt", "one\n"), await commit("b.txt", "two\n", "topic")])
    if (!done.ok) throw new Error(JSON.stringify(done.error));
  const pull = await openPull(app, alice, repo.value, { title: "t", body: "", baseBranch: "main", headBranch: "topic" });
  if (!pull.ok) throw new Error(JSON.stringify(pull.error));
  number = pull.value.number;
});

let spawned: string[][] = [];
let spy: ReturnType<typeof spyOn> | undefined;

beforeEach(() => {
  forgetDiffs();
  spawned = [];
  const real = Bun.spawn;
  spy = spyOn(Bun, "spawn").mockImplementation(((cmd: string[], options?: { cwd?: string }) => {
    if (cmd[0] === "git" && options?.cwd === dir) spawned.push(cmd.slice(1));
    return real(cmd, options as Parameters<typeof Bun.spawn>[1]);
  }) as typeof Bun.spawn);
});

afterEach(() => spy?.mockRestore());

afterAll(async () => {
  await servers.stop();
  app.close();
  if (cells === undefined) delete process.env["FORGE_CELLS"];
  else process.env["FORGE_CELLS"] = cells;
  await rm(dataDir, { recursive: true, force: true });
});

test("pullDiff reads git once, then answers the same tips from memory", async () => {
  const pull = getPull(app.db, repoId, number)!;
  const first = await pullDiff(dir, pull);
  expect(first.diff.files.map((f) => f.path)).toEqual(["b.txt"]);
  expect(spawned.some((args) => args[0] === "diff")).toBe(true);
  spawned = [];
  const again = await pullDiff(dir, pull);
  expect(again.diff).toBe(first.diff);
  expect(spawned).toEqual([]);
});

test("the API's second read of an unmoved pull spawns no git in its diff phase", async () => {
  const url = `${servers.url}/api/v1/repos/alice/r/pulls/${number}`;
  const first = await fetch(url);
  expect(first.status).toBe(200);
  expect(((await first.json()) as { diff: { files: unknown[] } }).diff.files).toHaveLength(1);
  expect(spawned.length).toBeGreaterThan(0);
  spawned = [];
  const again = await fetch(url);
  expect(again.status).toBe(200);
  expect(((await again.json()) as { diff: { files: unknown[] } }).diff.files).toHaveLength(1);
  expect(spawned).toEqual([]);
  const timing = again.headers.get("server-timing") ?? "";
  expect(timing).toContain("diff;dur=");
});
