/** The Asked tab wears the number of unshipped asks, on `/`, `/apps` and `/asked`; none reads plain `Asked` (#6745). */
import { forgetHome } from "../src/web/studio/home_last.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createIssue } from "../src/core/issues.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { homeTabs } from "../src/web/studio/home_tabs.ts";
import { proveAll } from "./helpers/verified.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let root = "";
let app: App;
let servers: Servers;
let cookie = "";
let repoId = "";
let userId = "";

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-asked-tab-"));
  app = createApp({ dataDir: root, port: 0, forgeRepo: "alice/forge" });
  const u = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  proveAll(app);
  const made = await createRepo(app, { id: u.value.id, username: "alice" } as never, { name: "r" });
  if (!made.ok) throw new Error(made.error);
  repoId = made.value.id;
  userId = u.value.id;
  servers = await serve(app);
  const signin = await fetch(`${servers.url}/signin`, {
    method: "POST",
    headers: { origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    redirect: "manual",
  });
  cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
});
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

/** The Asked tab's inner text, tags stripped. */
async function askedTab(path: string): Promise<string> {
  const res = await fetch(`${servers.url}${path}`, { headers: { cookie } });
  const page = await res.text();
  const nav = page.match(/<nav class="tabs" aria-label="Home"[\s\S]*?<\/nav>/)?.[0] ?? "";
  const m = nav.match(/<a[^>]*href="\/asked"[^>]*>([\s\S]*?)<\/a\s*>/);
  if (!m) throw new Error(`no Asked tab on ${path}`);
  return m[1]!.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

test("homeTabs reads plain Asked at 0 or when not given, and the count otherwise", () => {
  expect(String(homeTabs("feed"))).not.toContain("pill");
  expect(String(homeTabs("feed", 0))).not.toContain("pill");
  expect(String(homeTabs("feed", 3))).toContain("pill");
});

test("with no asks the Asked tab is plain on all three pages", async () => {
  forgetHome(app.db);
  for (const path of ["/feed?all=1", "/apps", "/asked"]) expect(await askedTab(path)).toBe("Asked");
});

test("three unshipped asks read Asked 3 on `/`, `/apps` and `/asked`", async () => {
  for (let i = 0; i < 3; i++) {
    const ask = createIssue(app.db, { repoId, authorId: userId, title: `Ask ${i}` });
    if (!ask.ok) throw new Error(ask.error);
  }
  forgetHome(app.db);
  for (const path of ["/feed?all=1", "/apps", "/asked"]) expect(await askedTab(path)).toBe("Asked 3");
  const res = await fetch(`${servers.url}/feed?all=1`, { headers: { cookie } });
  await res.arrayBuffer();
  expect(res.headers.get("server-timing") ?? "").toContain("asked;");
});
