/** GET /api/v1/repos/:owner/:name/tags carries an ETag and answers a repeat with 304 (#9161). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let cookie = "";
let dir = "";
const cells = process.env["FORGE_CELLS"];
const URL_ = "/api/v1/repos/alice/r/tags";

const git = async (...args: string[]): Promise<string> => {
  const p = Bun.spawn(["git", "-c", "user.name=t", "-c", "user.email=t@forge.local", "--git-dir", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  if ((await p.exited) !== 0) throw new Error(await new Response(p.stderr).text());
  return out.trim();
};
const get = (path: string, headers: Record<string, string> = {}) =>
  fetch(`${servers.url}${path}`, { headers: { cookie, ...headers } });

beforeAll(async () => {
  process.env["FORGE_CELLS"] = "off";
  dataDir = await mkdtemp(join(tmpdir(), "forge-tags-etag-"));
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
  cookie = `forge_session=${createSession(app.db, made.value.id).token}`;
  const repo = await createRepo(app, made.value, { name: "r", visibility: "public" });
  if (!repo.ok) throw new Error(String(repo.error));
  const done = await commitToBranch(app, made.value, repo.value, {
    message: "change",
    files: [{ path: "forge.json", content: "{}" }],
  });
  if (!done.ok) throw new Error(JSON.stringify(done.error));
  dir = repoDir(app.reposRoot, "alice", "r");
  const head = await git("rev-parse", repo.value.defaultBranch);
  await git("update-ref", "refs/tags/v1", head);
  await git("update-ref", "refs/tags/v2", head);
});

afterAll(async () => {
  await servers.stop();
  app.close();
  if (cells === undefined) delete process.env["FORGE_CELLS"];
  else process.env["FORGE_CELLS"] = cells;
  await rm(dataDir, { recursive: true, force: true });
});

test("first read has a weak etag, no-cache and vary", async () => {
  const res = await get(URL_);
  expect(res.status).toBe(200);
  expect(res.headers.get("etag")).toMatch(/^W\//);
  expect(res.headers.get("cache-control")).toBe("private, no-cache");
  expect(res.headers.get("vary")).toContain("authorization, cookie");
  await res.text();
});

test("a repeat is a 304 with no body and the floor headers", async () => {
  const tag = (await get(URL_)).headers.get("etag")!;
  const again = await get(URL_, { "if-none-match": tag });
  expect(again.status).toBe(304);
  expect(again.headers.get("etag")).toBe(tag);
  expect(again.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await again.text()).toBe("");
});

test("a different limit gets a different etag", async () => {
  const all = (await get(URL_)).headers.get("etag");
  const one = (await get(`${URL_}?limit=1`)).headers.get("etag");
  expect(one).not.toBe(all);
});

test("errors carry no etag", async () => {
  const bad = await get(`${URL_}?limit=0`);
  expect(bad.status).toBe(422);
  expect(bad.headers.get("etag")).toBeNull();
  const stale = await get(`${URL_}?cursor=gone`);
  expect(stale.status).toBe(422);
  expect(stale.headers.get("etag")).toBeNull();
  const missing = await get("/api/v1/repos/alice/nope/tags");
  expect(missing.status).toBe(404);
  expect(missing.headers.get("etag")).toBeNull();
});

test("pushing, re-pointing and deleting a tag each make the old etag miss", async () => {
  let tag = (await get(URL_)).headers.get("etag")!;
  const step = async (change: () => Promise<unknown>) => {
    await change();
    const res = await get(URL_, { "if-none-match": tag });
    expect(res.status).toBe(200);
    const next = res.headers.get("etag")!;
    expect(next).not.toBe(tag);
    tag = next;
  };
  await step(() => git("update-ref", "refs/tags/v3", "refs/tags/v1"));
  await git("commit-tree", "-m", "x", "refs/tags/v1^{tree}").then((c) => git("update-ref", "refs/tags/v4", c));
  tag = (await get(URL_)).headers.get("etag")!;
  await step(async () => git("update-ref", "refs/tags/v3", await git("rev-parse", "refs/tags/v4")));
  await step(() => git("update-ref", "-d", "refs/tags/v3"));
});
