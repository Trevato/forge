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

let dataDir = "", work = "";
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
  await git(["add", "."], dir);
  await git(["commit", "-m", "one"], dir);
  await git(["push", "origin", "main"], dir);
}, 60_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
});

const names = async (path: string): Promise<string[]> => {
  const res = await fetch(`${servers.url}${path}`, { headers: { authorization: `Bearer ${bearer}` } });
  await res.arrayBuffer();
  expect(res.status).toBe(200);
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
