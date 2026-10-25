/** The home's live fragments name their Server-Timing phases (#5400). */
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
let cookie = "";

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-live-timing-"));
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

const phases = (res: Response) =>
  (res.headers.get("server-timing") ?? "").split(",").map((p) => p.trim().split(";")[0]);

test.each([
  ["/live/apps", "apps", 'id="live-apps"'],
  ["/live/on-you", "asks", 'id="live-on-you"'],
])("%s names session, %s and render", async (path, read, marker) => {
  const res = await fetch(`${servers.url}${path}`, { headers: { cookie } });
  const body = await res.text();
  expect(res.status).toBe(200);
  expect(body).toContain(marker);
  const names = phases(res);
  for (const name of ["app", "session", read, "render"]) expect(names).toContain(name);
});
