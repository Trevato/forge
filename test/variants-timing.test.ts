/** `/:owner/:name/variants/:group` names session, repo, pulls, access and render in Server-Timing (#3424). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { gitClientEnv } from "./helpers/git-client.ts";
import { adminCookie } from "./helpers/admin.ts";

const gitEnv = gitClientEnv();
let dataDir = "";
let work = "";
let app: App;
let servers: Servers;
let cookie = "";

async function git(cwd: string, args: string[]): Promise<void> {
  const p = Bun.spawn(["git", ...args], { cwd, env: gitEnv, stdout: "ignore", stderr: "pipe" });
  const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-vt-"));
  work = await mkdtemp(join(tmpdir(), "forge-vt-work-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const base = servers.url;
  cookie = await adminCookie(app, { username: "dev", email: "dev@f.dev", password: "variants-timing-pass" });
  const token = await fetch(`${base}/api/v1/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ adminConfirm: true, username: "dev", password: "variants-timing-pass", name: "cli", scope: "rw" }),
  })
    .then((r) => r.json())
    .then((j) => (j as { token: string }).token);
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  await fetch(`${base}/api/v1/repos`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name: "app", visibility: "public" }),
  });
  await git(work, ["clone", `${base.replace("http://", `http://dev:${token}@`)}/dev/app.git`, "app"]);
  const dir = join(work, "app");
  await Bun.write(join(dir, "code.txt"), "alpha\n");
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-m", "base"]);
  await git(dir, ["push", "origin", "main"]);
  await git(dir, ["checkout", "-B", "a", "main"]);
  await Bun.write(join(dir, "code.txt"), "alpha\na\n");
  await git(dir, ["commit", "-am", "a"]);
  await git(dir, ["push", "origin", "a"]);
  await fetch(`${base}/api/v1/repos/dev/app/pulls`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ base: "main", head: "a", title: "Try a" }),
  });
  app.db.run("UPDATE pull SET variant_group = 'deck1'");
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
});

test("GET /:owner/:name/variants/:group names its phases", async () => {
  const res = await fetch(`${servers.url}/dev/app/variants/deck1`, { headers: { cookie } });
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("Try a");
  const parts = (res.headers.get("server-timing") ?? "").split(", ");
  for (const name of ["app", "session", "repo", "pulls", "access", "render"])
    expect(parts.find((p) => p.startsWith(`${name};`))).toMatch(/^[a-z]+;dur=\d+\.\d$/);
});
