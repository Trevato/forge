/** A repository's home names its Server-Timing phases on every path: an empty repository, a repository with code, and an app (#5414). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enableApp } from "../src/actions/apps.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { proveAll } from "./helpers/verified.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let root = "";
let app: App;
let servers: Servers;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-repo-home-paths-timing-"));
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
  const user = { id: u.value.id, username: "alice" } as never;
  const empty = await createRepo(app, user, { name: "empty" });
  if (!empty.ok) throw new Error(String(empty.error));
  const plain = await createRepo(app, user, { name: "plain" });
  if (!plain.ok) throw new Error(String(plain.error));
  const code = await commitToBranch(app, u.value, plain.value, {
    message: "Start",
    files: [{ path: "README.md", content: "p\n" }],
  });
  if (!code.ok) throw new Error(JSON.stringify(code.error));
  const made = await createRepo(app, user, { name: "vault" });
  if (!made.ok) throw new Error(String(made.error));
  const seeded = await commitToBranch(app, u.value, made.value, {
    message: "Start",
    files: [{ path: "README.md", content: "v\n" }],
  });
  if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  const enabled = await enableApp(app, u.value, made.value, { slug: "vault" });
  if (!enabled.ok) throw new Error(String(enabled.error));
  servers = await serve(app);
});
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

async function phases(path: string): Promise<string[]> {
  const signin = await fetch(`${servers.url}/signin`, {
    method: "POST",
    headers: { origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    redirect: "manual",
  });
  const cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
  const res = await fetch(`${servers.url}${path}`, { headers: { cookie } });
  await res.text();
  expect(res.status).toBe(200);
  const parts = (res.headers.get("server-timing") ?? "").split(", ");
  for (const p of parts) expect(p).toMatch(/^[a-z]+;dur=\d+(\.\d)?$/);
  return parts.map((p) => p.split(";")[0]!);
}

test("an empty repository's home names session, appof, refs and render", async () => {
  expect(await phases("/alice/empty")).toEqual(
    expect.arrayContaining(["app", "session", "appof", "refs", "render"]),
  );
});

test("a plain repository's home names session, each read and render", async () => {
  expect(await phases("/alice/plain")).toEqual(
    expect.arrayContaining(["app", "session", "appof", "refs", "tree", "readme", "following", "render"]),
  );
});

test("an app repository's home names session, each read and render", async () => {
  expect(await phases("/alice/vault")).toEqual(
    expect.arrayContaining(["app", "session", "opened", "crew", "pulls", "panels", "render"]),
  );
});
