/** A repository's settings pages name session, each read and render in Server-Timing, and cost a bounded number of statements (#4318). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { expectWork, requestStatements } from "./helpers/work.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
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
  const made = await createRepo(app, { id: u.value.id, username: "alice" } as never, { name: "forge" });
  if (!made.ok) throw new Error(made.error);
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
  "/alice/forge/settings": 62,
  "/alice/forge/settings/danger": 38,
  "/alice/forge/settings/hooks": 38,
  "/alice/forge/settings/labels": 38,
  "/alice/forge/settings/prompts": 38,
};

const PAGES: [string, string[]][] = [
  ["/alice/forge/settings", ["route", "session", "repo", "lead", "refs", "check", "mirror", "render", "compress"]],
  ["/alice/forge/settings/danger", ["route", "session", "repo", "render", "compress"]],
  ["/alice/forge/settings/hooks", ["route", "session", "repo", "hooks", "deliveries", "render", "compress"]],
  ["/alice/forge/settings/labels", ["route", "session", "repo", "labels", "render", "compress"]],
  ["/alice/forge/settings/prompts", ["route", "session", "repo", "sources", "render", "compress"]],
];

for (const [path, names] of PAGES)
  test(`GET ${path} names its phases and costs a bounded number of statements`, async () => {
    const get = async () => {
      const res = await fetch(`${servers.url}${path}`, { headers: { cookie } });
      await res.text();
      return res;
    };
    await get(); // warm
    const res = await get();
    expect(res.status).toBe(200);
    const parts = (res.headers.get("server-timing") ?? "").split(", ");
    const dur = (name: string) => Number(parts.find((p) => p.startsWith(`${name};`))?.match(/dur=([\d.]+)/)?.[1]);
    const got = parts.map((p) => p.split(";")[0]);
    for (const name of ["app", ...names]) {
      expect(got).toContain(name);
      expect(Number.isFinite(dur(name))).toBe(true);
    }
    expect(got.filter((n) => n === "render").length).toBe(1);
    expectWork(await requestStatements(app.db, `${servers.url}${path}`, { headers: { cookie } }), { max: MAX_STATEMENTS[path]! });
  });
