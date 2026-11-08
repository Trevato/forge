/** `/llms.txt` names repos and render in Server-Timing (#5376). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { proveAll } from "./helpers/verified.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let root = "";
let app: App;
let servers: Servers;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-llms-timing-"));
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
  for (const [name, visibility] of [["openyard", "public"], ["secretyard", "private"]] as const) {
    const r = await createRepo(app, u.value, { name, visibility });
    if (!r.ok) throw new Error(String(r.error));
  }
  servers = await serve(app);
});
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

test("GET /llms.txt names its phases and lists only public repositories", async () => {
  const res = await fetch(`${servers.url}/llms.txt`);
  const body = await res.text();
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  const timing = res.headers.get("server-timing") ?? "";
  expect(timing).toContain("repos;");
  expect(timing).toContain("render;");
  expect(body).toContain("alice/openyard");
  expect(body).not.toContain("secretyard");
});
