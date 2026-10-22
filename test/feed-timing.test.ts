/** The feed, its chips and the asks inbox name their phases in Server-Timing. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  root = mkdtempSync(join(tmpdir(), "forge-feed-timing-"));
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
  proveAll(app);
  servers = await serve(app);
});
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

const signIn = async () => {
  const res = await fetch(`${servers.url}/signin`, {
    method: "POST",
    headers: { origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    redirect: "manual",
  });
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
};

for (const [path, phase] of [
  ["/api/v1/feed", "feed"],
  ["/api/v1/feed/chips", "chips"],
  ["/api/v1/asks", "asks"],
] as const) {
  test(`GET ${path} names session, ${phase} and render`, async () => {
    const res = await fetch(`${servers.url}${path}`, { headers: { cookie: await signIn() } });
    await res.arrayBuffer();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const names = (res.headers.get("server-timing") ?? "").split(", ").map((p) => p.split(";")[0]);
    expect(names.filter((n) => ["session", phase, "render"].includes(n!))).toEqual(["session", phase, "render"]);
  });
}
