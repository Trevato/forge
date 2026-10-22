/** A repository's new issue, make-it-yours, report and toolbar pages name their phases and answer within budget (#4321). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { baselineMs, expectBudget } from "./helpers/budget.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newApp } from "../src/actions/apps.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { proveAll } from "./helpers/verified.ts";
import { quietLogs } from "./helpers/globals.ts";
import { promote } from "./helpers/members.ts";

quietLogs();

let root = "";
let app: App;
let servers: Servers;

async function signIn(username: string): Promise<string> {
  const res = await fetch(`${servers.url}/signin`, {
    method: "POST",
    headers: { origin: servers.url },
    body: new URLSearchParams({ username, password: "a-good-passphrase" }),
    redirect: "manual",
  });
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-repo-pages-timing-"));
  app = createApp({ dataDir: root, port: 0, forgeRepo: "alice/forge" });
  const users = [];
  for (const username of ["alice", "bob"]) {
    const u = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: username === "alice",
    });
    if (!u.ok) throw new Error(u.error);
    promote(app.db, u.value);
    users.push(u.value);
  }
  proveAll(app);
  const made = await newApp(app, { id: users[0]!.id, username: "alice" } as never, { name: "forge", description: "x", visibility: "public" });
  if (!made.ok) throw new Error(made.error);
  servers = await serve(app);
});
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

/** Path, who is signed in, the phases it names (bar `app` and `total`), in order. */
const PAGES: [path: string, who: string, names: string[]][] = [
  ["/alice/forge/issues/new", "alice", ["session", "repo", "render"]],
  ["/alice/forge/report", "alice", ["session", "repo", "access", "render"]],
  ["/alice/forge/toolbar", "alice", ["session", "repo", "app-row", "live", "runs", "render"]],
  ["/alice/forge/make-it-yours", "bob", ["session", "repo", "plan", "render"]],
];

for (const [path, who, names] of PAGES)
  test(`GET ${path} names its phases, they fit inside app, and it answers within its budget`, async () => {
    const against = await baselineMs(servers.url);
    const cookie = await signIn(who);
    const read = async (): Promise<string[]> => {
      const res = await fetch(`${servers.url}${path}`, { headers: { cookie } });
      await res.text();
      expect(res.status).toBe(200);
      return (res.headers.get("server-timing") ?? "").split(", ");
    };
    const dur = (part: string | undefined): number => {
      expect(part).toMatch(/^[a-z-]+;dur=\d+\.\d$/);
      return Number(part!.slice(part!.indexOf("=") + 1));
    };
    for (let i = 0; i < 5; i++) await read(); // warm
    const shares: number[] = [];
    for (let i = 0; i < 11; i++) {
      const parts = await read();
      const named = parts.map((p) => p.split(";")[0]!).filter((n) => n !== "app" && n !== "db");
      expect(named).toEqual(names);
      const total = dur(parts.find((p) => p.startsWith("app;")));
      const sum = parts.filter((p) => !/^(app|db);/.test(p)).reduce((s, p) => s + dur(p), 0);
      expectBudget(total, { ms: 50, against });
      expect(sum).toBeLessThanOrEqual(total + 0.1 * names.length);
      shares.push(total === 0 ? 1 : sum / total);
    }
    // `app` also holds routing and the security floor, outside these pages;
    // the median request is what the page can name of itself.
    shares.sort((a, b) => a - b);
    expect(shares[Math.floor(shares.length / 2)]!).toBeGreaterThanOrEqual(0.4);
  });
