/** The API's list of pulls names its Server-Timing phases (#3964). */
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openPull } from "../src/actions/pulls.ts";
import { mergeReadingsSettled } from "../src/core/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { expectWork, requestStatements } from "./helpers/work.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let cookie = "";
let alice: User;
let repo: Repo;
const cells = process.env["FORGE_CELLS"];

beforeAll(async () => {
  process.env["FORGE_CELLS"] = "off";
  dataDir = await mkdtemp(join(tmpdir(), "forge-api-pulls-timing-"));
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
  alice = made.value;
  cookie = `forge_session=${createSession(app.db, alice.id).token}`;
  const created = await createRepo(app, alice, { name: "r", visibility: "public" });
  if (!created.ok) throw new Error(String(created.error));
  repo = created.value;
  const first = await commitToBranch(app, alice, repo, {
    message: "change",
    files: [{ path: "forge.json", content: "{}" }],
  });
  if (!first.ok) throw new Error(JSON.stringify(first.error));
  for (const branch of ["one", "two"]) {
    const done = await commitToBranch(app, alice, repo, {
      branch,
      message: "change",
      files: [{ path: `${branch}.txt`, content: "x" }],
    });
    if (!done.ok) throw new Error(JSON.stringify(done.error));
    const pull = await openPull(app, alice, repo, {
      title: branch,
      body: "",
      baseBranch: "main",
      headBranch: branch,
    });
    if (!pull.ok) throw new Error(JSON.stringify(pull.error));
  }
});

afterAll(async () => {
  await servers.stop();
  app.close();
  if (cells === undefined) delete process.env["FORGE_CELLS"];
  else process.env["FORGE_CELLS"] = cells;
  await rm(dataDir, { recursive: true, force: true });
});

async function phases(path: string): Promise<{ status: number; names: string[]; body: string }> {
  const res = await fetch(`${servers.url}${path}`, { headers: { cookie } });
  const body = await res.text();
  const names = (res.headers.get("server-timing") ?? "").split(", ").map((p) => p.split(";")[0]!);
  return { status: res.status, names: names.slice(names.indexOf("app") + 1), body };
}

test("the pulls list names its five phases in order", async () => {
  const got = await phases("/api/v1/repos/alice/r/pulls");
  expect(got.status).toBe(200);
  expect(got.names).toEqual(["session", "list", "merge", "labels", "render"]);
  expect(JSON.parse(got.body).items).toHaveLength(2);
});

test("an unknown repository still names session", async () => {
  const got = await phases("/api/v1/repos/alice/nope/pulls");
  expect(got.status).toBe(404);
  expect(got.names).toEqual(["session"]);
});

test("130 open pulls read their mergeability from the cache: the merge phase is cheap and spawns no git", async () => {
  for (let i = 0; i < 128; i++) {
    const branch = `b${i}`;
    const done = await commitToBranch(app, alice, repo, {
      branch,
      message: "change",
      files: [{ path: `${branch}.txt`, content: "x" }],
    });
    if (!done.ok) throw new Error(JSON.stringify(done.error));
    const pull = await openPull(app, alice, repo, {
      title: branch,
      body: "",
      baseBranch: "main",
      headBranch: branch,
    });
    if (!pull.ok) throw new Error(JSON.stringify(pull.error));
  }
  const url = `${servers.url}/api/v1/repos/alice/r/pulls?limit=200`;
  const res = await fetch(url, { headers: { cookie } });
  expect((JSON.parse(await res.text()) as { items: unknown[] }).items.length).toBeGreaterThanOrEqual(130);
  // Past the list's budget the first readings finish in the background (#8156).
  await mergeReadingsSettled();
  const spawn = spyOn(Bun, "spawn");
  try {
    // Counted, not timed: one read per page, not one per pull (130 pulls, no N+1).
    const reads = await requestStatements(app.db, url, { headers: { cookie } });
    expect(spawn.mock.calls.filter((c) => (c[0] as string[]).includes("merge-tree")).length).toBe(0);
    expectWork(reads, { max: 16 });
  } finally {
    spawn.mockRestore();
  }
}, 120_000);
