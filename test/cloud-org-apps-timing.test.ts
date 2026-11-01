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
// `route` and `compress` are the server's own work around the handler: named,
// the accounting no longer hangs on how long a loaded machine takes outside it.
const PAGES: [string, string[]][] = [
  ["/settings/cloud/audit", ["route", "session", "audit", "render", "compress"]],
  ["/organizations/new", ["route", "session", "render", "compress"]],
  ["/apps/open", ["route", "session", "render", "compress"]],
];

/** The page's budget (ms), and the most a request may spend between its named phases (ms) when quiet. */
const BUDGET_MS = 50;
const ACCOUNTING_MS = 1.5;
/** Requests judged per page; each assertion takes its own best, so one stalled request cannot fail it. */
const SAMPLES = 7;

for (const [path, names] of PAGES)
  test(`GET ${path} names its phases and answers within its budget`, async () => {
    const against = await baselineMs(servers.url);
    const get = () => fetch(`${servers.url}${path}`, { headers: { cookie }, redirect: "manual" });
    await (await get()).text(); // warm
    // Timers jitter on a busy machine: judge the best of several requests.
    let left = Infinity;
    let total = Infinity;
    let last = "";
    for (let i = 0; i < SAMPLES; i++) {
      const res = await get();
      await res.text();
      const parts = (res.headers.get("server-timing") ?? "").split(", ");
      const dur = (n: string) => Number(parts.find((p) => p.startsWith(`${n};`))!.split("dur=")[1]);
      last = parts.join(", ");
      for (const name of ["app", ...names])
        expect(parts.find((p) => p.startsWith(`${name};`)), `phase ${name} in ${last}`).toMatch(/^[a-z]+;dur=\d+\.\d$/);
      total = Math.min(total, dur("app"));
      // Phases name the whole request: what is left over is small.
      left = Math.min(left, Math.abs(dur("app") - names.reduce((sum, n) => sum + dur(n), 0)));
    }
    expectBudget(total, { ms: BUDGET_MS, against });
    // The unnamed stretch (routing, before `session`) is fixed work, ~0.9 ms quiet and ~1.7 ms in a loaded
    // shard (#7519): it stretches with the machine, so it is judged against the same-run baseline like speed.
    try {
      expectBudget(left, { ms: ACCOUNTING_MS, against });
    } catch (e) {
      // Name the phases, so a red says whether the machine stalled or a phase went missing.
      throw new Error(`${(e as Error).message}; best app ${total.toFixed(1)} ms; last request ${last}`);
    }
  });

// Signed out, the redirect to sign-in is still a named phase.
for (const path of ["/settings/cloud/audit", "/organizations/new"])
  test(`signed-out GET ${path} names route, session, render and compress`, async () => {
    const res = await fetch(`${servers.url}${path}`, { redirect: "manual" });
    await res.text();
    expect(res.status).toBe(303);
    const parts = (res.headers.get("server-timing") ?? "").split(", ");
    const dur = (n: string) => Number(parts.find((p) => p.startsWith(`${n};`))!.split("dur=")[1]);
    const names = ["route", "session", "render", "compress"];
    for (const name of names)
      expect(parts.find((p) => p.startsWith(`${name};`))).toMatch(/^[a-z]+;dur=\d+\.\d$/);
    expect(Math.abs(dur("app") - names.reduce((sum, n) => sum + dur(n), 0))).toBeLessThan(1.5);
  });
