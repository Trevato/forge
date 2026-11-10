/**
 * A new app that has not run shows only its progress (#10299): its state line,
 * the box to tell the crew, and Now. Once it is older, or has shipped, the
 * rail and the previews list return; the empty cards never do.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enableApp } from "../src/actions/apps.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { proveAll } from "./helpers/verified.ts";
import { quietLogs } from "./helpers/globals.ts";
import { ageApp } from "./helpers/history.ts";

quietLogs();

let root = "";
let app: App;
let servers: Servers;
let runtime: AppsRuntime;
let cookie = "";
let repoId = "";

const read = async (as: string = cookie): Promise<string> =>
  (await fetch(`${servers.url}/alice/vault`, { headers: as ? { cookie: as } : {} })).text();

const signin = async (username: string): Promise<string> => {
  const r = await fetch(`${servers.url}/signin`, {
    method: "POST", headers: { origin: servers.url },
    body: new URLSearchParams({ username, password: "a-good-passphrase" }), redirect: "manual",
  });
  return (r.headers.get("set-cookie") ?? "").split(";")[0]!;
};
let bobCookie = "";

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-fresh-"));
  app = createApp({ dataDir: root, port: 0, forgeRepo: "alice/forge" });
  const u = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  proveAll(app);
  const bob = await createUser(app.db, {
    origin: "seed", trusted: true, username: "bob", email: "bob@forge.local", password: "a-good-passphrase",
  });
  if (!bob.ok) throw new Error(bob.error);
  const made = await createRepo(app, { id: u.value.id, username: "alice" } as never, { name: "vault", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  repoId = made.value.id;
  for (const [branch, path] of [["main", "README.md"], ["feature/x", "x.ts"]] as const) {
    const c = await commitToBranch(app, u.value, made.value, {
      message: "Start", branch, files: [{ path, content: "v\n" }],
    } as never);
    if (!c.ok) throw new Error(JSON.stringify(c.error));
  }
  const enabled = await enableApp(app, u.value, made.value, { slug: "vault" });
  if (!enabled.ok) throw new Error(String(enabled.error));
  const pull = await openPull(app, u.value, made.value, { title: "Add x", baseBranch: "main", headBranch: "feature/x" });
  if (!pull.ok) throw new Error(String(pull.error));
  servers = await serve(app);
  runtime = new AppsRuntime(app, {
    domain: "apps.test", scheme: "http", publicPort: servers.port, forgeUrl: servers.url, concurrency: 1,
  });
  cookie = await signin("alice");
  bobCookie = await signin("bob");
});

afterAll(async () => {
  await runtime.stop();
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

test("a new app that has not run shows its progress, the box and Now, and nothing else", async () => {
  const page = await read();
  expect(page).toContain("The crew is making it run");
  expect(page).toContain("Tell the crew");
  expect(page).toContain('id="live-now"');
  for (const gone of ["<aside", "<h2>Previews</h2>", "<h2>This week</h2>", "<h2>Crew</h2>", "No description yet"])
    expect(page).not.toContain(gone);
  // No description, no address yet: no empty paragraph under the name.
  expect(page).not.toMatch(/<p class="muted">\s*<\/p>/);
});

test("the owner still reaches the environment settings on a fresh app", async () => {
  const page = await read();
  expect(page).toContain("Environment settings");
});

test("the Now row links the pull's preview, since a fresh app has no previews list", async () => {
  const page = await read();
  expect(page).toContain('href="/alice/vault/app/pull-1/open"');
  expect(page).toContain('href="/alice/vault/pulls/1"');
});

test("a guest and a non-owner see the progress, with no owner facts and no terminal line", async () => {
  for (const who of ["", bobCookie]) {
    const page = await read(who);
    expect(page).toContain('id="live-now"');
    for (const gone of ["The terminal is off", "ssh ", "action=\"/alice/vault/tell\"", "Environment settings", "<aside", "Spent", "<h2>Crew</h2>"])
      expect(page).not.toContain(gone);
  }
});

test("an older app keeps its rail and previews, and still has no empty cards", async () => {
  ageApp(app.db, repoId);
  const page = await read();
  expect(page).toContain("<aside");
  expect(page).toContain("<h2>Previews</h2>");
  expect(page).toContain("Environment settings");
  expect(page).not.toContain("<h2>This week</h2>");
  expect(page).not.toContain("<h2>Crew</h2>");
  expect(page).not.toContain("The map</a>");
});
