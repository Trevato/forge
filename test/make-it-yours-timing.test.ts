/** `/:owner/:name/make-it-yours` names session, repo, plan and render in Server-Timing (#3509). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newApp } from "../src/actions/apps.ts";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { promote } from "./helpers/members.ts";

quietLogs();

let root = "";
let app: App;
let servers: Servers;
let cookie = "";

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-make-it-yours-timing-"));
  app = createApp({ dataDir: root, port: 0 });
  const mk = async (username: string, first = false) => {
    const r = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: first,
    });
    if (!r.ok) throw new Error(r.error);
    promote(app.db, r.value);
    return r.value;
  };
  const alice = await mk("alice", true);
  const bob = await mk("bob");
  const made = await newApp(app, alice, { name: "garden", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  cookie = `forge_session=${createSession(app.db, bob.id).token}`;
  servers = await serve(app);
}, 60_000);
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

test("GET /:owner/:name/make-it-yours names its phases", async () => {
  const res = await fetch(`${servers.url}/alice/garden/make-it-yours`, { headers: { cookie } });
  const body = await res.text();
  expect(res.status).toBe(200);
  expect(body).toContain("Make it yours");
  const parts = (res.headers.get("server-timing") ?? "").split(", ");
  for (const name of ["app", "session", "repo", "plan", "render"])
    expect(parts.find((p) => p.startsWith(`${name};`))).toMatch(/^[a-z]+;dur=\d+\.\d$/);
});
