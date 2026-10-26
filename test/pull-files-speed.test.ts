/** A pull's Files page on a diff cache hit: `diff` is a lookup, and `checks` one indexed read (#6128). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { checkSummary, checksForHead, createRun } from "../src/core/runs.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { clearHeadReads } from "../src/web/head-reads.ts";
import { clearDiffCache, diffCacheCounts } from "../src/web/diff-cache.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let url = "";
let headOid = "";
let issueId = "";
const cells = process.env["FORGE_CELLS"];

beforeAll(async () => {
  process.env["FORGE_CELLS"] = "off";
  dataDir = await mkdtemp(join(tmpdir(), "forge-files-speed-"));
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
  const base = await commitToBranch(app, alice, repo.value, {
    message: "base", files: [{ path: "forge.json", content: "{}" }],
  });
  const big = await commitToBranch(app, alice, repo.value, {
    branch: "big",
    message: "big",
    files: Array.from({ length: 40 }, (_, f) => ({
      path: `src/m${f}.ts`,
      content: Array.from({ length: 50 }, (_, i) => `export const v${f}_${i} = ${i};`).join("\n") + "\n",
    })),
  });
  if (!base.ok || !big.ok) throw new Error("seed commits failed");
  const pull = await openPull(app, alice, repo.value, { title: "big", body: "", baseBranch: "main", headBranch: "big" });
  if (!pull.ok) throw new Error(JSON.stringify(pull.error));
  url = `${servers.url}/alice/r/pulls/${pull.value.number}/files`;
  headOid = pull.value.headOid;
  issueId = pull.value.id;
  for (let n = 0; n < 3; n++)
    createRun(app.db, { repoId: repo.value.id, kind: "check", issueId, env: "pull-1", commitOid: headOid });
});

afterAll(async () => {
  await servers.stop();
  app.close();
  if (cells === undefined) delete process.env["FORGE_CELLS"];
  else process.env["FORGE_CELLS"] = cells;
  await rm(dataDir, { recursive: true, force: true });
});

const phase = (header: string, name: string) => {
  const m = header.match(new RegExp(`(?:^|, )${name};dur=([\\d.]+)(?:;desc="(\\w+)")?`));
  return m ? { ms: Number(m[1]), desc: m[2] } : undefined;
};

const timing = (res: Response) => res.headers.get("server-timing") ?? "";

test("a 40-file pull's second Files request is a diff cache hit and renders far less than the first", async () => {
  clearDiffCache();
  clearHeadReads();
  const first = await fetch(url);
  await first.arrayBuffer();
  const before = diffCacheCounts();
  const second = await fetch(url);
  expect(await second.text()).toContain("m39.ts");
  const after = diffCacheCounts();
  // Counted, not timed: the second request parsed and highlighted nothing.
  expect(after.hits).toBe(before.hits + 1);
  expect(after.misses).toBe(before.misses);
  expect(phase(timing(second), "diff")?.desc).toBe("hit");
  // Relative to the first request in this run, so a loaded machine slows both.
  const cold = phase(timing(first), "render")!.ms + phase(timing(first), "diff")!.ms;
  const warm = phase(timing(second), "render")!.ms + phase(timing(second), "diff")!.ms;
  expect(warm).toBeLessThan(cold / 2);
});

test("the checks summary is the newest of several runs, and the shared read honours its limit", () => {
  const db = app.db;
  const all = checksForHead(db, issueId, headOid);
  expect(all.length).toBeGreaterThan(1);
  expect(checksForHead(db, issueId, headOid, 1)).toEqual([all[0]!]);
  const { run, state } = checkSummary(db, issueId, headOid);
  expect(run).toEqual(all[0]!);
  expect(state).toBe(all[0]!.state);
  expect(checkSummary(db, issueId, "0".repeat(40))).toEqual({ state: "none", run: null });
});
