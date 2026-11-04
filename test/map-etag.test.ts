/** GET …/map carries a weak ETag and answers a repeat with 304 while the map has not moved (#9156). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { addDependency } from "../src/core/dependencies.ts";
import { createIssue } from "../src/core/issues.ts";
import { createRun } from "../src/core/runs.ts";
import { getRepoById, updateRepoSettings } from "../src/core/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let repoId: string;
let userId: string;
let bearer = "";
const MAP = "/api/v1/repos/alice/notes/map";

const get = (headers: Record<string, string> = {}, auth = true, path = MAP) =>
  fetch(`${servers.url}${path}`, {
    headers: { ...(auth ? { authorization: `Bearer ${bearer}` } : {}), ...headers },
  });
const mk = (title: string, sealed = false) => {
  const r = createIssue(app.db, { repoId, authorId: userId, title, body: "", kind: "issue", sealed });
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
/** The tag now, after proving the previous one no longer holds. */
async function changed(before: string, what: string): Promise<string> {
  const res = await get({ "if-none-match": before });
  expect(res.status, what).toBe(200);
  const tag = res.headers.get("etag")!;
  expect(tag, what).not.toBe(before);
  await res.text();
  return tag;
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-mapetag-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const admin = await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  if (!admin.ok) throw new Error(admin.error);
  userId = admin.value.id;
  const made = await createRepo(app, admin.value, { name: "notes", visibility: "public", description: "" });
  if (!made.ok) throw new Error(String(made.error));
  repoId = made.value.id;
  updateRepoSettings(app.db, getRepoById(app.db, repoId)!, { plansNeedNod: false });
  mk("First");
  mk("Second");
  const minted = await fetch(`${servers.url}/api/v1/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ adminConfirm: true, username: "alice", password: "correct-horse-battery", name: "cli", scope: "admin" }),
  });
  bearer = ((await minted.json()) as { token: string }).token;
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("the answer carries a weak tag, private no-cache and vary", async () => {
  const res = await get();
  expect(res.status).toBe(200);
  expect(res.headers.get("etag")).toMatch(/^W\/"/);
  expect(res.headers.get("cache-control")).toBe("private, no-cache");
  expect(res.headers.get("vary")).toContain("authorization, cookie");
  await res.text();
});

test("a matching If-None-Match is a bodiless 304 that runs no graph phase and says so", async () => {
  const first = await get();
  const tag = first.headers.get("etag")!;
  await first.text();
  const again = await get({ "if-none-match": tag });
  expect(again.status).toBe(304);
  expect(again.headers.get("etag")).toBe(tag);
  expect(await again.text()).toBe("");
  const timing = again.headers.get("server-timing") ?? "";
  expect(timing).toContain("not-modified");
  expect(timing).toMatch(/graph;dur=[\d.]+;desc="hit"/);
  // Another poll with no change keeps the same tag.
  const third = await get();
  expect(third.headers.get("etag")).toBe(tag);
  await third.text();
});

test("opening, blocking, closing, a run and a pillar each make a new tag", async () => {
  let tag = (await get()).headers.get("etag")!;
  const a = mk("Opened");
  tag = await changed(tag, "open");
  const b = mk("Blocker");
  tag = await changed(tag, "open another");
  const dep = addDependency(app.db, a, b, userId);
  expect(dep.ok).toBe(true);
  tag = await changed(tag, "block");
  createRun(app.db, { repoId, kind: "agent", issueId: b.id, reason: "test" });
  tag = await changed(tag, "run starts");
  mk("P1 First pillar: umbrella");
  tag = await changed(tag, "pillar");
  app.db.run("UPDATE issue SET state = 'closed' WHERE id = ?1", [b.id]);
  await changed(tag, "close");
});

test("readers with different sealed scopes never share a tag, and a sealed issue does not leak", async () => {
  mk("Hidden", true);
  const owner = await get();
  const stranger = await get({}, false);
  expect(owner.status).toBe(200);
  expect(stranger.status).toBe(200);
  const ownerTag = owner.headers.get("etag")!;
  const strangerTag = stranger.headers.get("etag")!;
  expect(ownerTag).not.toBe(strangerTag);
  expect(await owner.text()).toContain("Hidden");
  expect(await stranger.text()).not.toContain("Hidden");
  // The owner's tag buys a stranger nothing.
  const replay = await get({ "if-none-match": ownerTag }, false);
  expect(replay.status).toBe(200);
  expect(await replay.text()).not.toContain("Hidden");
});

test("?done=1 is tagged apart from the open-only answer", async () => {
  const open = await get();
  const all = await get({}, true, `${MAP}?done=1`);
  expect(all.headers.get("etag")).not.toBe(open.headers.get("etag"));
  await open.text();
  await all.text();
});
