/** `/verify`, `/recover` and `/claim` name their phases in Server-Timing and cost a bounded number of statements, signed in (#4317). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { expectWork, requestStatements } from "./helpers/work.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let root = "";
let app: App;
let servers: Servers;
let cookie = "";

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-verify-timing-"));
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

/** The most statements a request may run: today's count with room for a read or two. */
const MAX_STATEMENTS: Record<string, number> = {
  "/verify?token=nope": 12,
  "/recover": 10,
  "/recover?token=nope": 12,
  "/claim": 10,
};

const PAGES: [string, string[]][] = [
  ["/verify?token=nope", ["session", "verify", "render"]],
  ["/recover", ["session", "render"]],
  ["/recover?token=nope", ["session", "link", "render"]],
  ["/claim", ["session", "render"]],
];

for (const [path, names] of PAGES)
  test(`GET ${path} names its phases and costs a bounded number of statements`, async () => {
    const get = () => fetch(`${servers.url}${path}`, { headers: { cookie }, redirect: "manual" });
    await (await get()).text(); // warm
    const res = await get();
    await res.text();
    const parts = (res.headers.get("server-timing") ?? "").split(", ");
    for (const name of ["app", ...names])
      expect(parts.find((p) => p.startsWith(`${name};`))).toMatch(/^[a-z]+;dur=\d+\.\d$/);
    expectWork(await requestStatements(app.db, `${servers.url}${path}`, { headers: { cookie }, redirect: "manual" }), { max: MAX_STATEMENTS[path]! });
  });
