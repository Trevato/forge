/** The map's ready/blocked issue rows join the shell's j/k row traversal: one `data-nav` row each, none when empty (#10342). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { addDependency } from "../src/core/dependencies.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let root = "";
let app: App;
let servers: Servers;
let cookie = "";

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-map-keys-"));
  app = createApp({ dataDir: root, port: 0 });
  const u = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  const alice = u.value;
  for (const name of ["busy", "bare"]) {
    const made = await createRepo(app, alice, { name, visibility: "private" });
    if (!made.ok) throw new Error(made.error);
    if (name === "bare") continue;
    const a = await openIssue(app, alice, made.value, { title: "First thing" });
    const b = await openIssue(app, alice, made.value, { title: "Second thing" });
    if (!a.ok || !b.ok) throw new Error("issue");
    const dep = addDependency(app.db, b.value, a.value, alice.id);
    if (!dep.ok) throw new Error(dep.error);
  }
  servers = await serve(app);
  const res = await fetch(`${servers.url}/signin`, {
    method: "POST",
    headers: { origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    redirect: "manual",
  });
  cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
});
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

const get = async (path: string) =>
  (await fetch(`${servers.url}${path}`, { headers: { cookie } })).text();

test("each ranked issue row is a data-nav link to the issue's own page", async () => {
  const text = await get("/alice/busy/map");
  const navs = text.match(/<a [^>]*data-nav[^>]*>/g) ?? [];
  expect(navs.length).toBeGreaterThanOrEqual(2);
  expect(navs.some((a) => a.includes('href="/alice/busy/issues/1"'))).toBe(true);
  expect(navs.every((a) => a.includes('tabindex="-1"'))).toBe(true);
});

test("a map with no issues has no data-nav", async () => {
  const text = await get("/alice/bare/map");
  expect(text).not.toContain("data-nav");
});
