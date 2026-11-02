/**
 * A followed upstream's record (#5979): every check is kept, the last 20 per
 * repository; the settings card lists the last 5, newest first, each worded.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { checkLine } from "../src/actions/upstream_follow.ts";
import { createUser } from "../src/core/users.ts";
import { listChecks, noteCheck, putFollow } from "../src/core/upstream_follow.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dataDir = "";
let app: App;
let servers: Servers;
let repoId = "";
let userId = "";
let cookie = "";
const hoursAgo = (h: number): string => new Date(Date.now() - h * 3_600_000).toISOString();

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-follow-history-"));
  app = createApp({ dataDir, port: 0 });
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error(JSON.stringify(made.error));
  userId = made.value.id;
  const repo = await createRepo(app, made.value, { name: "square", visibility: "public" });
  if (!repo.ok) throw new Error(JSON.stringify(repo.error));
  repoId = repo.value.id;
  putFollow(app.db, {
    repoId,
    url: "https://example.com/up/stream.git",
    branch: "main",
    enabled: true,
    byId: userId,
    originId: "",
  });
  servers = await serve(app);
  const res = await fetch(`${servers.url}/signin`, {
    method: "POST",
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    redirect: "manual",
  });
  cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}, 30_000);

afterAll(async () => {
  servers?.stop();
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

const card = async (): Promise<string> =>
  (await fetch(`${servers.url}/alice/square/settings`, { headers: { cookie } })).text();

test("a repository with no history shows only today's line", async () => {
  expect(listChecks(app.db, repoId)).toEqual([]);
  expect(await card()).not.toContain("data-following-history");
});

test("25 checks keep 20 and show 5, newest first, each outcome worded", async () => {
  for (let i = 1; i <= 25; i++) noteCheck(app.db, repoId, { at: hoursAgo(26 - i), behind: i, error: "" });
  expect(listChecks(app.db, repoId, 100)).toHaveLength(20);
  const shown = listChecks(app.db, repoId);
  expect(shown.map((c) => c.behind)).toEqual([25, 24, 23, 22, 21]);

  noteCheck(app.db, repoId, { at: hoursAgo(2), behind: 3, error: "conflict", files: 2 });
  noteCheck(app.db, repoId, { at: hoursAgo(1), error: "The upstream could not be read: nope\nsecond line" });
  noteCheck(app.db, repoId, { at: hoursAgo(1), behind: 4, error: "" });
  const [merged, failed, conflict] = listChecks(app.db, repoId);
  expect(checkLine(merged!, "2h ago")).toBe("2h ago · 4 behind · merged");
  expect(checkLine(failed!, "1h ago")).toBe("1h ago · 3 behind · error: The upstream could not be read: nope");
  expect(checkLine(conflict!, "2h ago")).toBe("2h ago · 3 behind · conflict in 2 files");

  const page = await card();
  expect(page.match(/row-title"[^>]*>[^<]*· \d+ behind ·/g)).toHaveLength(5);
  expect(page).toContain("data-following-history");
  expect(page).toContain("· conflict in 2 files");
  expect(page.indexOf("4 behind · merged")).toBeLessThan(page.indexOf("conflict in 2 files"));
});

test("pointing the follow at another upstream forgets the record", () => {
  noteCheck(app.db, repoId, { at: hoursAgo(1), behind: 1, error: "" });
  expect(listChecks(app.db, repoId).length).toBeGreaterThan(0);
  putFollow(app.db, {
    repoId,
    url: "https://example.com/other/stream.git",
    branch: "main",
    enabled: true,
    byId: userId,
    originId: "",
  });
  expect(listChecks(app.db, repoId)).toEqual([]);
});
