/**
 * A repository with 200 branches lists them with a fixed number of git processes: ahead/behind and
 * tips are one git call each, not one per branch.
 */
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { divergence, listBranches, parseAheadBehind, tipCommits } from "../src/git/branches.ts";
import { commitLog } from "../src/git/read.ts";
import { repoDir } from "../src/git/repos.ts";
import { gitClientEnv } from "./helpers/git-client.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { expectWork } from "./helpers/work.ts";

const env = gitClientEnv({
  GIT_AUTHOR_NAME: "A",
  GIT_AUTHOR_EMAIL: "a@forge.local",
  GIT_COMMITTER_NAME: "A",
  GIT_COMMITTER_EMAIL: "a@forge.local",
});

async function git(args: string[], cwd: string): Promise<void> {
  const p = Bun.spawn(["git", ...args], { cwd, env, stdout: "ignore", stderr: "pipe" });
  const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
}

let dataDir = "", work = "";
let app: App, servers: Servers, bearer = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-bbr-"));
  work = await mkdtemp(join(tmpdir(), "forge-bbrwork-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const base = servers.url;
  await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  const minted = await fetch(`${base}/api/v1/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ adminConfirm: true, username: "alice", password: "correct-horse-battery", name: "cli", scope: "admin" }),
  });
  const { token } = (await minted.json()) as { token: string };
  bearer = token;
  await fetch(`${base}/api/v1/repos`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: "app", description: "x" }),
  });
  await git(["clone", `${base.replace("http://", `http://alice:${token}@`)}/alice/app.git`, "app"], work);
  const dir = join(work, "app");
  await Bun.write(join(dir, "a.ts"), "export const a = 1;\n");
  await Bun.write(join(dir, "README.md"), "# app\n");
  await git(["add", "."], dir);
  await git(["commit", "-m", "one"], dir);
  await git(["push", "origin", "main"], dir);
  // 199 branches (200 with main), each one commit off main; main then moves on, so every
  // branch is also one behind.
  let stream = "";
  for (let i = 0; i < 199; i++) {
    const name = `feat/b${String(i).padStart(3, "0")}`;
    stream += `commit refs/heads/${name}\ncommitter A <a@forge.local> ${1700000000 + i} +0000\ndata 4\nb${String(i).padStart(2, "0")}\nfrom refs/heads/main\n\n`;
  }
  const fi = Bun.spawn(["git", "fast-import", "--quiet"], { cwd: dir, env, stdin: new TextEncoder().encode(stream), stderr: "pipe" });
  if ((await fi.exited) !== 0) throw new Error(await new Response(fi.stderr).text());
  await Bun.write(join(dir, "b.ts"), "export const b = 2;\n");
  await git(["add", "."], dir);
  await git(["commit", "-m", "two"], dir);
  await git(["push", "origin", "--all"], dir);
}, 60_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
});

/** How many processes `work` starts: counted, not timed (#7824). */
async function spawns(work: () => Promise<unknown>): Promise<number> {
  const spy = spyOn(Bun, "spawn");
  try {
    await work();
    return spy.mock.calls.length;
  } finally {
    spy.mockRestore();
  }
}

const get = async (path: string): Promise<{ text: string; timing: string }> => {
  const res = await fetch(`${servers.url}${path}`, { headers: { authorization: `Bearer ${bearer}` } });
  const text = await res.text();
  expect(res.status).toBe(200);
  return { text, timing: res.headers.get("server-timing") ?? "" };
};

test("200 branches start a bounded number of git processes and name their phases", async () => {
  await get("/alice/app/branches");
  let page = { text: "", timing: "" };
  // One batched read of the refs, not a process per branch.
  expectWork(await spawns(async () => void (page = await get("/alice/app/branches"))), { max: 4 });
  const { text, timing } = page;
  const dur = (name: string) => Number(new RegExp(`(?:^|, )${name};dur=([0-9.]+)`).exec(timing)?.[1]);
  for (const phase of ["session", "refs", "compare", "render"]) expect(dur(phase)).toBeGreaterThanOrEqual(0);
  expect(text).toContain("200 branches");
  expect(text).toContain("feat/b198");
  // The tip line comes from tipCommits: a shifted field would drop or garble it.
  expect(text).toMatch(/· b\d+ · updated <time datetime="2023-11-14T[\s\S]{0,200}?by A</);
}, 30_000);

test("the one-call counts equal the per-branch rev-list counts", async () => {
  const dir = repoDir(app.reposRoot, "alice", "app");
  const listed = await listBranches(dir, "main");
  if (!listed.ok) throw new Error("listBranches failed");
  expect(listed.value.compared).toBe(true);
  const main = listed.value.branches.find((b) => b.isDefault)!;
  expect(listed.value.branches.length).toBe(200);
  expect(main.name).toBe("main");
  for (const b of listed.value.branches) {
    const want = await divergence(dir, main.oid, b.oid);
    expect({ name: b.name, ahead: b.ahead, behind: b.behind }).toEqual({ name: b.name, ...want });
  }
  expect(listed.value.branches[1]).toMatchObject({ name: "feat/b000", ahead: 1, behind: 1 });
}, 60_000);

test("the API returns the first 30 of 200 branches with the whole list's counts, and a page of it starts a bounded number of git processes", async () => {
  const dir = repoDir(app.reposRoot, "alice", "app");
  const full = await listBranches(dir, "main");
  if (!full.ok) throw new Error("listBranches failed");
  const path = "/api/v1/repos/alice/app/branches?limit=30";
  await get(path);
  let got = { text: "", timing: "" };
  expectWork(await spawns(async () => void (got = await get(path))), { max: 5 });
  const { text } = got;
  const page = JSON.parse(text) as { items: { name: string; ahead: number | null; behind: number | null }[]; next_cursor: string | null };
  // Rows, order and cursor are the whole list's first 30.
  expect(page.items.map((i) => [i.name, i.ahead, i.behind])).toEqual(
    full.value.branches.slice(0, 30).map((b) => [b.name, b.ahead, b.behind]),
  );
  expect(page.next_cursor).toBe(page.items[29]!.name);
  const next = JSON.parse((await get(`${path}&cursor=${encodeURIComponent(page.next_cursor!)}`)).text) as typeof page;
  expect(next.items[0]!.name).toBe(full.value.branches[30]!.name);
  expect(next.items[0]).toMatchObject({ ahead: 1, behind: 1 });
}, 30_000);

test("the per-branch fallback gives the same rows, and the one-call path starts fewer processes", async () => {
  const dir = repoDir(app.reposRoot, "alice", "app");
  const run = async (opts: { bulk?: boolean }) => {
    let last = await listBranches(dir, "main", opts);
    const started = await spawns(async () => void (last = await listBranches(dir, "main", opts)));
    return { last, started };
  };
  const { last: bulk, started: bulkSpawns } = await run({});
  const { last: slow, started: slowSpawns } = await run({ bulk: false });
  if (!bulk.ok || !slow.ok) throw new Error("listBranches failed");
  expect(slow.value).toEqual(bulk.value);
  expect(bulkSpawns).toBeLessThan(slowSpawns);
  expectWork(bulkSpawns, { max: 5 });
}, 60_000);

test("a malformed or unsupported ahead-behind output gives up so the slow path runs", () => {
  expect(parseAheadBehind("refs/heads/a\u00001 2\nrefs/heads/b\u00000 0")).toEqual(
    new Map([["a", { ahead: 1, behind: 2 }], ["b", { ahead: 0, behind: 0 }]]),
  );
  expect(parseAheadBehind("")).toEqual(new Map());
  // An older git prints the format atom verbatim or empty; a torn line has no pair.
  expect(parseAheadBehind("refs/heads/a\u0000")).toBeUndefined();
  expect(parseAheadBehind("refs/heads/a\u0000%(ahead-behind:abc)")).toBeUndefined();
  expect(parseAheadBehind("refs/heads/a\u00001 2\nrefs/heads/b")).toBeUndefined();
  expect(parseAheadBehind("refs/heads/a\u00001 x")).toBeUndefined();
  expect(parseAheadBehind("\u00001 2")).toBeUndefined();
});

async function head(cwd: string, rev = "HEAD"): Promise<string> {
  const p = Bun.spawn(["git", "rev-parse", rev], { cwd, env, stdout: "pipe", stderr: "ignore" });
  return (await new Response(p.stdout).text()).trim();
}

test("tipCommits reads every field commitLog does: body, parents, author, date", async () => {
  const dir = join(work, "tips");
  await git(["init", "-q", "-b", "main", dir], work);
  const commit = (subject: string, body: string, author: string) => {
    env.GIT_AUTHOR_NAME = author;
    return git(
      ["commit", "--allow-empty", "-m", subject, ...(body ? ["-m", body] : [])],
      dir,
    );
  };
  const dated = (date: string) => Object.assign(env, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  dated("2024-01-02T03:04:05+02:00");
  await commit("root", "", "Root");
  dated("2024-03-04T05:06:07+00:00");
  await git(["switch", "-q", "-c", "side"], dir);
  await commit("side work", "first line\n\nsecond paragraph\nthird line", "Side");
  const sideTip = await head(dir);
  await git(["switch", "-q", "main"], dir);
  dated("2024-05-06T07:08:09-05:00");
  await commit("main work", "", "Main");
  dated("2024-06-07T08:09:10+00:00");
  await git(["merge", "--no-ff", "-q", "-m", "merge side", "-m", "joins two histories", "side"], dir);
  const mergeTip = await head(dir);
  const rootTip = await head(dir, "HEAD~2");
  const oids = [rootTip, sideTip, await head(dir, "HEAD^"), mergeTip];

  const tips = await tipCommits(dir, oids);
  expect(tips.size).toBe(4);
  for (const oid of oids) {
    const want = await commitLog(dir, oid, { limit: 1 });
    if (!want.ok) throw new Error("commitLog failed");
    expect(tips.get(oid)).toEqual(want.value[0]!);
  }
  expect(tips.get(mergeTip)!.parents).toHaveLength(2);
  expect(tips.get(mergeTip)!.body).toBe("joins two histories");
  expect(tips.get(sideTip)!.body).toBe("first line\n\nsecond paragraph\nthird line");
  expect(tips.get(sideTip)!.author).toBe("Side");
  expect(tips.get(sideTip)!.date).toBe("2024-03-04T05:06:07Z");
  expect(tips.get(rootTip)!.parents).toEqual([]);
  // An unsafe oid is dropped, never handed to git.
  expect((await tipCommits(dir, ["--output=x", mergeTip])).size).toBe(1);
}, 60_000);

test("a warm look shows a branch that moved or appeared since the last look", async () => {
  await get("/alice/app/branches");
  const dir = join(work, "app");
  await git(["switch", "-q", "feat/b000"], dir);
  await git(["commit", "--allow-empty", "-m", "moved on"], dir);
  await git(["push", "-q", "origin", "feat/b000"], dir);
  await git(["switch", "-q", "-c", "feat/zz-new"], dir);
  await git(["push", "-q", "origin", "feat/zz-new"], dir);
  const { text } = await get("/alice/app/branches");
  expect(text).toContain("201 branches");
  expect(text).toContain("feat/zz-new");
  expect(text).toContain("moved on");
  await git(["push", "-q", "origin", "--delete", "feat/zz-new"], dir);
  expect((await get("/alice/app/branches")).text).toContain("200 branches");
}, 60_000);
