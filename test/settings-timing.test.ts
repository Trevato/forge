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
    expectBudget(dur("app"), { ms: 50, against });
    const sum = names.reduce((t, n) => t + dur(n), 0);
    // The rest of `app` is the server's own routing and header work, outside any page (~1-2 ms on every page).
    expect(sum).toBeLessThanOrEqual(dur("app") + 0.3);
    const gap = dur("app") - sum;
    expect(gap).toBeLessThanOrEqual(5); // accounting, not speed
  });
