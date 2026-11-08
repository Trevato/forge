/** One commit's page names session, git, highlight and render in Server-Timing (#3632). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { gitClientEnv } from "./helpers/git-client.ts";
import { adminCookie } from "./helpers/admin.ts";

const LONG = "x".repeat(300);

let dataDir = "";
let work = "";
let app: App;
let servers: Servers;
let oid = "";
let bodyOid = "";

const env = gitClientEnv({
  GIT_AUTHOR_NAME: "Ada",
  GIT_AUTHOR_EMAIL: "ada@forge.local",
  GIT_COMMITTER_NAME: "Ada",
  GIT_COMMITTER_EMAIL: "ada@forge.local",
});

async function sh(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(args, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${args.join(" ")} failed: ${err}`);
  return out.trim();
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-commit-timing-"));
  work = await mkdtemp(join(tmpdir(), "forge-commit-timing-work-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const cookie = await adminCookie(app, {
    username: "ada",
    email: "ada@forge.local",
    password: "analytical-engine",
  });
  await fetch(`${servers.url}/new`, {
    method: "POST",
    headers: { cookie },
    body: new URLSearchParams({ name: "engine", visibility: "public", description: "d" }),
    redirect: "manual",
  });
  const minted = await fetch(`${servers.url}/api/v1/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      adminConfirm: true,
      username: "ada",
      password: "analytical-engine",
      name: "cli",
      scope: "rw",
    }),
  });
  const token = ((await minted.json()) as { token: string }).token;
  const remote = `${servers.url.replace("http://", `http://ada:${token}@`)}/ada/engine.git`;
  await sh(["git", "clone", remote, "engine"], work);
  const dir = join(work, "engine");
  await Bun.write(join(dir, "a.ts"), "export const a = 1;\n");
  await sh(["git", "add", "."], dir);
  await sh(["git", "commit", "-m", "add a"], dir);
  await sh(["git", "push", "origin", "main"], dir);
  oid = await sh(["git", "rev-parse", "HEAD"], dir);
  await Bun.write(join(dir, "b.ts"), "export const b = 2;\n");
  await sh(["git", "add", "."], dir);
  await sh(["git", "commit", "-m", "add b", "-m", "Why b <exists>:\n  because a needs it\n" + LONG], dir);
  await sh(["git", "push", "origin", "main"], dir);
  bodyOid = await sh(["git", "rev-parse", "HEAD"], dir);
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
});

test("GET /:owner/:name/commit/:oid names its phases", async () => {
  const res = await fetch(`${servers.url}/ada/engine/commit/${oid}`);
  const body = await res.text();
  expect(res.status).toBe(200);
  expect(body).toContain("add a");
  const parts = (res.headers.get("server-timing") ?? "").split(", ");
  for (const name of ["app", "session", "git", "highlight", "render"])
    expect(parts.find((p) => p.startsWith(`${name};`))).toMatch(/^[a-z]+;dur=\d+\.\d$/);
});

test("a commit's head draws §5's bar, not .issue-meta", async () => {
  const body = await (await fetch(`${servers.url}/ada/engine/commit/${oid}`)).text();
  expect(body).not.toContain("issue-meta");
  expect(body).not.toContain("issue-head");
  expect(body).toContain("Ada committed");
  expect(body).toContain("Browse files");
  expect(body).toContain(oid.slice(0, 7));
});

test("a commit's head and body draw §5's card-head and prose, not commit-head/commit-body", async () => {
  const body = await (await fetch(`${servers.url}/ada/engine/commit/${oid}`)).text();
  expect(body).not.toContain("commit-head");
  expect(body).not.toContain("commit-body");
  expect(body).toContain('<div class="card-head"><h2>add a</h2></div>');
});

test("a commit with a body shows it, escaped, inside the prose message div", async () => {
  const page = await (await fetch(`${servers.url}/ada/engine/commit/${bodyOid}`)).text();
  expect(page).toContain(
    `<div class="prose" data-text="message"><pre>Why b &lt;exists&gt;:\n  because a needs it\n${LONG}</pre></div>`,
  );
  const bare = await (await fetch(`${servers.url}/ada/engine/commit/${oid}`)).text();
  expect(bare).not.toContain('data-text="message"');
});

test("the message rule drops the code box and padding, and wraps a long line instead of scrolling", async () => {
  const page = await (await fetch(`${servers.url}/ada/engine/commit/${oid}`)).text();
  const href = page.match(/href="(\/assets\/[^"]+\.css)"/)?.[1] ?? "";
  const css = await (await fetch(`${servers.url}${href}`)).text();
  const pre = css.match(/\.prose\[data-text="message"\] pre\s*\{[^}]*\}/)?.[0] ?? "";
  expect(pre).toMatch(/background:\s*none/);
  expect(pre).toMatch(/border:\s*0/);
  expect(pre).toMatch(/padding:\s*0/);
  expect(pre).toMatch(/white-space:\s*pre-wrap/);
  expect(pre).toMatch(/overflow-wrap:\s*anywhere/);
  expect(css).toMatch(/\.prose\[data-text="message"\]\s*\{[^}]*padding:\s*0/);
});
