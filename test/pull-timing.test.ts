/** `/:owner/:name/pulls/:n`'s Server-Timing names its phases (#3192). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createRun } from "../src/core/runs.ts";
import { createSession } from "../src/core/sessions.ts";
import type { Repo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let cookie = "";
let number = 0;
let owner: User;
let repoRow: Repo;
const cells = process.env["FORGE_CELLS"];

beforeAll(async () => {
  process.env["FORGE_CELLS"] = "off";
  dataDir = await mkdtemp(join(tmpdir(), "forge-pull-timing-"));
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
  owner = alice;
  cookie = `forge_session=${createSession(app.db, alice.id).token}`;
  const repo = await createRepo(app, alice, { name: "r", visibility: "public" });
  if (!repo.ok) throw new Error(String(repo.error));
  repoRow = repo.value;
  for (const [branch, file] of [[undefined, "forge.json"], ["topic", "t.txt"]] as const) {
    const done = await commitToBranch(app, alice, repo.value, {
      ...(branch === undefined ? {} : { branch }),
      message: "change",
      files: [{ path: file, content: file === "forge.json" ? "{}" : "x" }],
    });
    if (!done.ok) throw new Error(JSON.stringify(done.error));
  }
  const pull = await openPull(app, alice, repo.value, {
    title: "t",
    body: "",
    baseBranch: "main",
    headBranch: "topic",
  });
  if (!pull.ok) throw new Error(JSON.stringify(pull.error));
  number = pull.value.number;
  createRun(app.db, {
    repoId: repo.value.id,
    kind: "check",
    issueId: pull.value.id,
    env: `pull-${number}`,
    commitOid: pull.value.headOid,
  });
});

afterAll(async () => {
  await servers.stop();
  app.close();
  if (cells === undefined) delete process.env["FORGE_CELLS"];
  else process.env["FORGE_CELLS"] = cells;
  await rm(dataDir, { recursive: true, force: true });
});

test("a pull names session, diff, checks, reviews and render after app, summing to no more than app", async () => {
  const res = await fetch(`${servers.url}/alice/r/pulls/${number}`, { headers: { cookie } });
  expect(res.status).toBe(200);
  await res.arrayBuffer();
  const parts = (res.headers.get("server-timing") ?? "").split(", ");
  const names = parts.map((p) => p.split(";")[0]!);
  const after = names.slice(names.indexOf("app") + 1);
  expect(after).toEqual(["session", "diff", "checks", "reviews", "render"]);
  const ms = (n: string) => Number(parts[names.indexOf(n)]!.match(/dur=([\d.]+)/)![1]);
  const sum = after.reduce((t, n) => t + ms(n), 0);
  // Each is rounded to 0.1 ms, so allow one step per phase.
  expect(sum).toBeLessThanOrEqual(ms("app") + 0.1 * after.length);
  expect(ms("diff")).toBeGreaterThan(0);
  expect(ms("checks")).toBeGreaterThan(0);
});

/** The `app` duration of one Files-page view, in ms. */
async function filesApp(): Promise<number> {
  const res = await fetch(`${servers.url}/alice/r/pulls/${number}/files`, { headers: { cookie } });
  expect(res.status).toBe(200);
  await res.arrayBuffer();
  const app = (res.headers.get("server-timing") ?? "").match(/(?:^|, )app;dur=([\d.]+)/);
  return Number(app![1]);
}

test("the Files page's cold first view of a fresh head: median of 3 under a ceiling beside its measurement", async () => {
  const runs: number[] = [];
  for (let i = 0; i < 3; i++) {
    // A new head each time, so nothing rendered before is reused.
    const done = await commitToBranch(app, owner, repoRow, {
      branch: "topic",
      message: `head ${i}`,
      files: Array.from({ length: 20 }, (_, f) => ({
        path: `d/f${f}.ts`,
        content: Array.from({ length: 50 }, (_, l) => `export const v${i}_${f}_${l} = ${l};`).join("\n"),
      })),
    });
    if (!done.ok) throw new Error(JSON.stringify(done.error));
    runs.push(await filesApp());
  }
  const median = runs.sort((a, b) => a - b)[1]!;
  // Measured over 10 runs of this file: the median of 3 was 76-95 ms (typically ~85), a single
  // render up to 147 ms. 170 ms is 2x the typical median: loose enough for a slow machine, tight
  // enough to catch a return to per-line highlighting.
  expect(median).toBeLessThan(170);
});
