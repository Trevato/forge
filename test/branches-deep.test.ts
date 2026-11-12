/**
 * The branches list compares only the page it returns (#6225): on a repo with
 * deep history and 200 branches forked at spread-out points, a 30-row page
 * costs clearly less git time than a 200-row page. Comparing every branch
 * for every page would make the two equal.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { repoDir } from "../src/git/repos.ts";
import { compareBranches } from "../src/git/branches.ts";
import { gitClientEnv } from "./helpers/git-client.ts";
import { seedAdmin } from "./helpers/admin.ts";

const COMMITS = 3000;
/** Each branch carries its own run of commits, so each comparison costs a walk. */
const OWN = 150;
const env = gitClientEnv({
  GIT_AUTHOR_NAME: "A",
  GIT_AUTHOR_EMAIL: "a@forge.local",
  GIT_COMMITTER_NAME: "A",
  GIT_COMMITTER_EMAIL: "a@forge.local",
});

let dataDir = "";
let app: App, servers: Servers, bearer = "", dir = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-bdeep-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  const minted = await fetch(`${servers.url}/api/v1/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ adminConfirm: true, username: "alice", password: "correct-horse-battery", name: "cli", scope: "admin" }),
  });
  bearer = ((await minted.json()) as { token: string }).token;
  await fetch(`${servers.url}/api/v1/repos`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ name: "deep", description: "x" }),
  });
  dir = repoDir(app.reposRoot, "alice", "deep");
  let stream = "";
  for (let i = 0; i < COMMITS; i++)
    stream += `commit refs/heads/main\nmark :${i + 1}\ncommitter A <a@forge.local> ${1700000000 + i} +0000\ndata 1\nc\n\n`;
  for (let b = 0; b < 199; b++) {
    const name = `feat/b${String(b).padStart(3, "0")}`;
    for (let k = 0; k < OWN; k++)
      stream += `commit refs/heads/${name}\ncommitter A <a@forge.local> ${1800000000 + k} +0000\ndata 1\nx\n${k === 0 ? `from :${b * 10 + 5}\n` : ""}\n`;
  }
  const fi = Bun.spawn(["git", "fast-import", "--quiet"], { cwd: dir, env, stdin: new TextEncoder().encode(stream), stderr: "pipe" });
  if ((await fi.exited) !== 0) throw new Error(await new Response(fi.stderr).text());
}, 120_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function gitMs(query: string): Promise<{ ms: number; items: { name: string; ahead: number | null }[] }> {
  const res = await fetch(`${servers.url}/api/v1/repos/alice/deep/branches?${query}`, {
    headers: { authorization: `Bearer ${bearer}` },
  });
  const body = (await res.json()) as { items: { name: string; ahead: number | null }[] };
  expect(res.status).toBe(200);
  const ms = Number(/(?:^|, )compare;dur=([0-9.]+)/.exec(res.headers.get("server-timing") ?? "")?.[1]);
  return { ms, items: body.items };
}

// Four runs, the first dropped as warm-up (page cache, git startup): best of three timed.
async function best(query: string) {
  let fastest = Infinity;
  let items: { name: string; ahead: number | null }[] = [];
  for (let i = 0; i < 4; i++) {
    const got = await gitMs(query);
    if (i > 0) fastest = Math.min(fastest, got.ms);
    items = got.items;
  }
  return { fastest, items };
}

test("a 30-row page compares 30 branches, not 200: its git phase is well under the 200-row page's", async () => {
  const small = await best("limit=30");
  const full = await best("limit=200");
  expect(small.items).toHaveLength(30);
  expect(full.items).toHaveLength(200);
  expect(small.items.every((i) => i.ahead === OWN || i.name === "main")).toBe(true);
  expect(small.fastest).toBeLessThan(full.fastest * 0.6);
}, 60_000);

test("an empty page compares nothing", async () => {
  const listed = await compareBranches(dir, "main", [], 200);
  expect(listed.branches).toEqual([]);
  const last = await gitMs("limit=200");
  expect(last.items).toHaveLength(200);
});
