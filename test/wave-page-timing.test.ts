/** `/:owner/:name/waves/:version` names session, repo, wave and render in Server-Timing (#3633). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { writeWave } from "../src/story/wave.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let root = "";
let app: App;
let servers: Servers;
let cookie = "";

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-wave-page-timing-"));
  app = createApp({ dataDir: root, port: 0 });
  servers = await serve(app);
  const u = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "keeper",
    email: "keeper@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  cookie = `forge_session=${createSession(app.db, u.value.id).token}; forge_mode=dev`;
  const made = await createRepo(app, u.value, { name: "alpha", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  const w = writeWave({
    version: "0.1.0",
    date: "2026-01-01",
    headline: "First",
    highlights: [1, 2, 3].map((n) => ({ title: `Thing ${n}`, why: "because" })),
    pulls: [{ title: "#1 A pull", url: "https://forge.example/o/r/pulls/1" }],
  });
  if (!w.ok) throw w.error;
  const c = await commitToBranch(app, u.value, made.value, {
    message: "wave",
    files: [{ path: "waves/0.1.0.md", content: w.value }],
  });
  if (!c.ok) throw new Error(JSON.stringify(c.error));
}, 30_000);
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

test("GET a wave page names its phases", async () => {
  const res = await fetch(`${servers.url}/keeper/alpha/waves/0.1.0`, { headers: { cookie } });
  const body = await res.text();
  expect(res.status).toBe(200);
  expect(body).toContain("<h1>First</h1>");
  const parts = (res.headers.get("server-timing") ?? "").split(", ");
  for (const name of ["app", "session", "repo", "wave", "render"])
    expect(parts.find((p) => p.startsWith(`${name};`))).toMatch(/^[a-z]+;dur=\d+\.\d$/);
});
