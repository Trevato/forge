/** A repository's new issue, make-it-yours, report and toolbar pages name their phases and cost a bounded number of statements (#4321). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { expectWork, requestStatements } from "./helpers/work.ts";
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

/** The most statements a request may run: today's count with room for a read or two. */
const MAX_STATEMENTS: Record<string, number> = {
  "/alice/forge/issues/new": 38,
  "/alice/forge/report": 36,
  "/alice/forge/toolbar": 21,
  "/alice/forge/make-it-yours": 27,
};

/** Path, who is signed in, the phases it names (bar `app` and `total`), in order. */
const PAGES: [path: string, who: string, names: string[]][] = [
  ["/alice/forge/issues/new", "alice", ["session", "repo", "render"]],
  ["/alice/forge/report", "alice", ["session", "repo", "access", "render"]],
  ["/alice/forge/toolbar", "alice", ["session", "repo", "app-row", "live", "side", "runs", "render"]],
  ["/alice/forge/make-it-yours", "bob", ["session", "repo", "plan", "render"]],
];

for (const [path, who, names] of PAGES)
  test(`GET ${path} names its phases, and it costs a bounded number of statements`, async () => {
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
    await read(); // warm
    for (let i = 0; i < 3; i++) {
      const parts = await read();
      const named = parts.map((p) => p.split(";")[0]!).filter((n) => n !== "app" && n !== "db");
      expect(named).toEqual(names);
      for (const part of parts) dur(part);
    }
    expectWork(await requestStatements(app.db, `${servers.url}${path}`, { headers: { cookie } }), { max: MAX_STATEMENTS[path]! });
  });
