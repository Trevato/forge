/** `/settings/keys`, `/settings/tokens` and `/settings/password` name their phases signed in and answer within budget (#4316). */
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
  root = mkdtempSync(join(tmpdir(), "forge-settings-timing-"));
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

const PAGES: [string, string[]][] = [
  ["/settings/keys", ["session", "keys", "render"]],
  ["/settings/tokens", ["session", "tokens", "sessions", "render"]],
  ["/settings/password", ["session", "render"]],
];

for (const [path, names] of PAGES)
  test(`GET ${path} names its phases and answers within its budget`, async () => {
    const against = await baselineMs(servers.url);
    await fetch(`${servers.url}${path}`, { headers: { cookie } }); // warm
    // A GC pause or a busy core between phases lands in one request, not all: judge the best of three.
    const seen: { app: number; sum: number }[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${servers.url}${path}`, { headers: { cookie } });
      await res.text();
      expect(res.status).toBe(200);
      const parts = (res.headers.get("server-timing") ?? "").split(", ");
      const dur = (name: string) => {
        const part = parts.find((p) => p.startsWith(`${name};`));
        expect(part).toMatch(/^[a-z]+;dur=\d+\.\d$/);
        return Number(part!.slice(`${name};dur=`.length));
      };
      expect(parts.map((p) => p.split(";")[0]).filter((n) => n !== "app")).toEqual(names);
      seen.push({ app: dur("app"), sum: names.reduce((t, n) => t + dur(n), 0) });
    }
    expectBudget(Math.min(...seen.map((s) => s.app)), { ms: 50, against });
    // The rest of `app` is the server's own routing and header work, outside any page (~1-2 ms on every page);
    // under load it stretches with the baseline, as the budget does.
    const slack = Math.max(0.3, against * 0.1);
    const room = Math.max(5, against); // accounting, not speed
    expect(Math.min(...seen.map((s) => s.sum - s.app))).toBeLessThanOrEqual(slack);
    expect(Math.min(...seen.map((s) => s.app - s.sum))).toBeLessThanOrEqual(room);
  });
