/** `/:owner/:name/app` and its `answers`, `now` and `state` fragments name their Server-Timing phases and cost a bounded number of statements (#4320). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { expectWork, requestStatements } from "./helpers/work.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enableApp } from "../src/actions/apps.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
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
  root = mkdtempSync(join(tmpdir(), "forge-app-pages-timing-"));
  app = createApp({ dataDir: root, port: 0, forgeRepo: "alice/forge" });
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
  const made = await createRepo(app, { id: u.value.id, username: "alice" } as never, { name: "vault" });
  if (!made.ok) throw new Error(String(made.error));
  const seeded = await commitToBranch(app, u.value, made.value, {
    message: "Start",
    files: [{ path: "README.md", content: "v\n" }],
  });
  if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  const enabled = await enableApp(app, u.value, made.value, { slug: "vault" });
  if (!enabled.ok) throw new Error(String(enabled.error));
  // A second repository with no app: the not-found paths are named too.
  const bare = await createRepo(app, { id: u.value.id, username: "alice" } as never, { name: "bare" });
  if (!bare.ok) throw new Error(String(bare.error));
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
  "/app": 10,
  "/app/answers": 10,
  "/app/now": 26,
  "/app/state": 21,
};

/** Route → the reads it makes, between `session` and `render`. */
const ROUTES: [string, string[]][] = [
  ["/app", ["repo", "view"]],
  ["/app/answers", ["repo", "access", "answers"]],
  ["/app/now", ["repo", "record", "pulls", "crew", "owner", "panels"]],
  ["/app/state", ["repo", "record", "pulls", "panels"]],
];

function phases(header: string | null): Map<string, number> {
  const out = new Map<string, number>();
  for (const part of (header ?? "").split(", ")) {
    const m = /^([a-z]+);dur=(\d+\.\d)/.exec(part);
    if (m) out.set(m[1]!, Number(m[2]));
  }
  return out;
}

const get = (path: string) =>
  fetch(`${servers.url}${path}`, { headers: { cookie }, redirect: "manual" });

for (const [route, reads] of ROUTES)
  test(`GET /alice/vault${route} names its phases and costs a bounded number of statements`, async () => {
    await (await get(`/alice/vault${route}`)).arrayBuffer(); // warm
    for (let i = 0; i < 5; i++) {
      const res = await get(`/alice/vault${route}`);
      await res.arrayBuffer();
      expect(res.status).toBeLessThan(400);
      const got = phases(res.headers.get("server-timing"));
      for (const name of ["session", ...reads, "render"]) expect(got.has(name)).toBe(true);
    }
    expectWork(await requestStatements(app.db, `${servers.url}/alice/vault${route}`, { headers: { cookie }, redirect: "manual" }), { max: MAX_STATEMENTS[route]! });
  });

for (const [route] of ROUTES)
  test(`GET /alice/bare${route} names session and render when there is no app`, async () => {
    const res = await get(`/alice/bare${route}`);
    await res.arrayBuffer();
    const got = phases(res.headers.get("server-timing"));
    expect(got.has("session")).toBe(true);
    expect(got.has("render")).toBe(true);
  });
