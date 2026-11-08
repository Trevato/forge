/** A repository's tree and blob pages name their phases in Server-Timing. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { gitClientEnv } from "./helpers/git-client.ts";
import { seedAdmin } from "./helpers/admin.ts";

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

let dataDir = "", work = "", commit = "";
let app: App, servers: Servers, bearer = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-btime-"));
  work = await mkdtemp(join(tmpdir(), "forge-btimework-"));
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
  await Bun.write(join(dir, "big.bin"), "x".repeat(1_200_000));
  await git(["add", "."], dir);
  await git(["commit", "-m", "one"], dir);
  await git(["push", "origin", "main"], dir);
  const rev = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: dir, env });
  commit = rev.stdout.toString().trim();
}, 60_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
});

const names = async (path: string, status = 200): Promise<string[]> => {
  const res = await fetch(`${servers.url}${path}`, { headers: { authorization: `Bearer ${bearer}` } });
  await res.arrayBuffer();
  expect(res.status).toBe(status);
  return (res.headers.get("server-timing") ?? "").split(", ").map((p) => p.split(";")[0]!);
};

const once = (got: string[]): void => {
  expect(new Set(got).size).toBe(got.length);
};

test("a tree names session, git and render once each, and no highlight", async () => {
  const got = await names("/alice/app/tree/main");
  expect(got).toEqual(expect.arrayContaining(["app", "session", "git", "render"]));
  expect(got).not.toContain("highlight");
  once(got);
});

test("a blob names session, git, highlight and render once each", async () => {
  const got = await names("/alice/app/blob/main/a.ts");
  expect(got).toEqual(expect.arrayContaining(["app", "session", "git", "highlight", "render"]));
  once(got);
});

test("a blob preview fragment names render and git once, no explorer read", async () => {
  const got = await names("/alice/app/blob/main/a.ts?fragment=1");
  expect(got).toEqual(expect.arrayContaining(["session", "git", "highlight", "render"]));
  once(got);
});

test("a rendered Markdown blob sends no highlight", async () => {
  const got = await names("/alice/app/blob/main/README.md");
  expect(got).toEqual(expect.arrayContaining(["git", "render"]));
  expect(got).not.toContain("highlight");
  once(got);
});

test("raw names session and git once each, and no stream", async () => {
  const got = await names("/alice/app/raw/main/a.ts");
  expect(got).toEqual(expect.arrayContaining(["app", "session", "git"]));
  expect(got).not.toContain("stream");
  once(got);
});

test("raw names session on a 404", async () => {
  const got = await names("/alice/app/raw/main/nope.ts", 404);
  expect(got).toContain("session");
  once(got);
});

test("media on a small file names session and git, no stream", async () => {
  const got = await names("/alice/app/media/main/a.ts");
  expect(got).toEqual(expect.arrayContaining(["app", "session", "git"]));
  expect(got).not.toContain("stream");
  once(got);
});

test("media on a large file names stream once", async () => {
  const got = await names("/alice/app/media/main/big.bin");
  expect(got).toEqual(expect.arrayContaining(["session", "git", "stream"]));
  once(got);
});

test("media on a 404 names session and git, not stream", async () => {
  const got = await names("/alice/app/media/main/nope.ts", 404);
  expect(got).toEqual(expect.arrayContaining(["session", "git"]));
  expect(got).not.toContain("stream");
  once(got);
});

test("a repeat media read at a full commit id is held and names no git", async () => {
  const first = await names(`/alice/app/media/${commit}/a.ts`);
  expect(first).toContain("git");
  const again = await names(`/alice/app/media/${commit}/a.ts`);
  expect(again).toContain("session");
  expect(again).not.toContain("git");
  expect(again).not.toContain("stream");
  once(again);
});

test("a repeat raw read at a full commit id is held and names no git", async () => {
  const first = await names(`/alice/app/raw/${commit}/README.md`);
  expect(first).toContain("git");
  const again = await names(`/alice/app/raw/${commit}/README.md`);
  expect(again).toContain("session");
  expect(again).not.toContain("git");
  once(again);
});

test("a media 304 names git but no stream", async () => {
  const first = await fetch(`${servers.url}/alice/app/media/main/big.bin`, { headers: { authorization: `Bearer ${bearer}` } });
  await first.arrayBuffer();
  const res = await fetch(`${servers.url}/alice/app/media/main/big.bin`, {
    headers: { authorization: `Bearer ${bearer}`, "if-none-match": first.headers.get("etag") ?? "" },
  });
  await res.arrayBuffer();
  expect(res.status).toBe(304);
  const got = (res.headers.get("server-timing") ?? "").split(", ").map((p) => p.split(";")[0]!);
  expect(got).toEqual(expect.arrayContaining(["session", "git"]));
  expect(got).not.toContain("stream");
  once(got);
});
