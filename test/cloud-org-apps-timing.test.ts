/** `/settings/cloud/audit`, `/organizations/new` and `/apps/open` name their Server-Timing phases and cost a bounded number of statements (#4322). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { expectWork, requestStatements } from "./helpers/work.ts";
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
  root = mkdtempSync(join(tmpdir(), "forge-cloud-timing-"));
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

/** The most statements a request may run: today's count with room for a read or two. */
const MAX_STATEMENTS: Record<string, number> = {
  "/settings/cloud/audit": 11,
  "/organizations/new": 10,
  "/apps/open": 10,
};

// /apps/open with no host is the answer a stranger gets: session, then render.
// `route` and `compress` are the server's own work around the handler: named,
// the accounting no longer hangs on how long a loaded machine takes outside it.
const PAGES: [string, string[]][] = [
  ["/settings/cloud/audit", ["route", "session", "audit", "render", "compress"]],
  ["/organizations/new", ["route", "session", "render", "compress"]],
  ["/apps/open", ["route", "session", "render", "compress"]],
];

/** Requests checked for their named phases. */
const SAMPLES = 7;

for (const [path, names] of PAGES)
  test(`GET ${path} names its phases and costs a bounded number of statements`, async () => {
    const get = () => fetch(`${servers.url}${path}`, { headers: { cookie }, redirect: "manual" });
    await (await get()).text(); // warm
    for (let i = 0; i < SAMPLES; i++) {
      const res = await get();
      await res.text();
      const parts = (res.headers.get("server-timing") ?? "").split(", ");
      for (const name of ["app", ...names])
        expect(parts.find((p) => p.startsWith(`${name};`)), `phase ${name} in ${parts.join(", ")}`).toMatch(/^[a-z]+;dur=\d+\.\d$/);
    }
    expectWork(await requestStatements(app.db, `${servers.url}${path}`, { headers: { cookie }, redirect: "manual" }), { max: MAX_STATEMENTS[path]! });
  });

// Signed out, the redirect to sign-in is still a named phase.
for (const path of ["/settings/cloud/audit", "/organizations/new"])
  test(`signed-out GET ${path} names route, session, render and compress`, async () => {
    const res = await fetch(`${servers.url}${path}`, { redirect: "manual" });
    await res.text();
    expect(res.status).toBe(303);
    const parts = (res.headers.get("server-timing") ?? "").split(", ");
    const names = ["route", "session", "render", "compress"];
    for (const name of names)
      expect(parts.find((p) => p.startsWith(`${name};`))).toMatch(/^[a-z]+;dur=\d+\.\d$/);
  });
