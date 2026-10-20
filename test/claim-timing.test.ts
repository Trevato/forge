/** `GET /claim` names session, spawned, owners and render in Server-Timing (#3526). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createOrg } from "../src/core/orgs.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let root = "";
let app: App;
let servers: Servers;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-claim-timing-"));
  app = createApp({ dataDir: root, port: 0 });
  const u = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "maker",
    email: "maker@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  const org = createOrg(app.db, "kin", u.value.id);
  if (!org.ok) throw new Error(org.error);
  await Bun.write(join(root, "parent.json"), JSON.stringify({ org: "kin" }));
  servers = await serve(app);
});
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

test("GET /claim names its phases", async () => {
  const res = await fetch(`${servers.url}/claim`);
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("This forge is yours");
  const parts = (res.headers.get("server-timing") ?? "").split(", ");
  for (const name of ["app", "session", "spawned", "owners", "render"])
    expect(parts.find((p) => p.startsWith(`${name};`))).toMatch(/^[a-z]+;dur=\d+\.\d$/);
});
