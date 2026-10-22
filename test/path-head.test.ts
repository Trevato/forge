/** The tree and blob path heads are drawn with §5's bar, and keep their breadcrumb links. */
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
  dataDir = await mkdtemp(join(tmpdir(), "forge-pathhead-"));
  work = await mkdtemp(join(tmpdir(), "forge-pathhead-work-"));
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
  await Bun.write(join(dir, "lib", "a.ts"), "export const a = 1;\n");
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


const page = async (path: string): Promise<string> => {
  const r = await fetch(`${servers.url}${path}`, { headers: { authorization: `Bearer ${bearer}` } });
  expect(r.status).toBe(200);
  return r.text();
};

test("the tree's path head is a bar with its breadcrumb links", async () => {
  const body = await page("/alice/app/tree/main/lib");
  expect(body).not.toContain("path-head");
  expect(body).toContain('class="bar mb"');
  expect(body).toContain('href="/alice/app/tree/main"');
});

test("the blob's path head is a bar with its breadcrumb links and actions", async () => {
  const body = await page("/alice/app/blob/main/lib/a.ts");
  expect(body).not.toContain("path-head");
  expect(body).toContain('class="bar mb"');
  expect(body).toContain('href="/alice/app/tree/main/lib"');
  expect(body).toContain('href="/alice/app/raw/main/lib/a.ts"');
});
