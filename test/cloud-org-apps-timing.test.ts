/** `/settings/cloud/audit`, `/organizations/new` and `/apps/open` name their Server-Timing phases and answer within budget (#4322). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { baselineMs, expectBudget } from "./helpers/budget.ts";
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

// /apps/open with no host is the answer a stranger gets: session, then render.
const PAGES: [string, string[]][] = [
  ["/settings/cloud/audit", ["session", "audit", "render"]],
  ["/organizations/new", ["session", "render"]],
  ["/apps/open", ["session", "render"]],
];

for (const [path, names] of PAGES)
  test(`GET ${path} names its phases and answers within its budget`, async () => {
    const against = await baselineMs(servers.url);
    const get = () => fetch(`${servers.url}${path}`, { headers: { cookie }, redirect: "manual" });
    await (await get()).text(); // warm
    // Timers jitter on a busy machine: judge the best of several requests.
    let left = Infinity;
    let total = Infinity;
    for (let i = 0; i < 7; i++) {
      const res = await get();
      await res.text();
      const parts = (res.headers.get("server-timing") ?? "").split(", ");
      const dur = (n: string) => Number(parts.find((p) => p.startsWith(`${n};`))!.split("dur=")[1]);
      for (const name of ["app", ...names])
        expect(parts.find((p) => p.startsWith(`${name};`))).toMatch(/^[a-z]+;dur=\d+\.\d$/);
      total = Math.min(total, dur("app"));
      // Phases name the whole request: what is left over is small.
      left = Math.min(left, Math.abs(dur("app") - names.reduce((sum, n) => sum + dur(n), 0)));
    }
    expectBudget(total, { ms: 50, against });
    expect(left).toBeLessThanOrEqual(1.5); // accounting, not speed: each phase is rounded to 0.1
  });

// Signed out, the redirect to sign-in is still a named phase.
for (const path of ["/settings/cloud/audit", "/organizations/new"])
  test(`signed-out GET ${path} names session and render`, async () => {
    const res = await fetch(`${servers.url}${path}`, { redirect: "manual" });
    await res.text();
    expect(res.status).toBe(303);
    const parts = (res.headers.get("server-timing") ?? "").split(", ");
    const dur = (n: string) => Number(parts.find((p) => p.startsWith(`${n};`))!.split("dur=")[1]);
    for (const name of ["session", "render"])
      expect(parts.find((p) => p.startsWith(`${name};`))).toMatch(/^[a-z]+;dur=\d+\.\d$/);
    expect(Math.abs(dur("app") - dur("session") - dur("render"))).toBeLessThan(1.5);
  });
