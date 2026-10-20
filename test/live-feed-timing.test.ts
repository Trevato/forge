/** `/live/feed` names session, feed and render in Server-Timing (#3403). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
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
  root = mkdtempSync(join(tmpdir(), "forge-live-feed-timing-"));
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
  const made = await createRepo(app, { id: u.value.id, username: "alice" } as never, { name: "forge" });
  if (!made.ok) throw new Error(made.error);
  servers = await serve(app);
});
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

const signIn = async () => {
  const signin = await fetch(`${servers.url}/signin`, {
    method: "POST",
    headers: { origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    redirect: "manual",
  });
  return (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
};
const names = (res: Response) =>
  (res.headers.get("server-timing") ?? "").split(", ").map((p) => p.split(";")[0]);

test("GET /live/feed names its phases", async () => {
  const res = await fetch(`${servers.url}/live/feed`, { headers: { cookie: await signIn() } });
  expect(res.status).toBe(200);
  expect(await res.text()).toContain('id="live-feed"');
  const parts = (res.headers.get("server-timing") ?? "").split(", ");
  for (const name of ["app", "session", "feed", "render"])
    expect(parts.find((p) => p.startsWith(`${name};`))).toMatch(/^[a-z]+;dur=\d+\.\d$/);
});

test("signed out, /live/feed is a 404 fragment that still names session", async () => {
  const res = await fetch(`${servers.url}/live/feed`);
  expect(res.status).toBe(404);
  expect(await res.text()).toBe("");
  expect(names(res)).toContain("session");
  expect(names(res)).not.toContain("feed");
});
