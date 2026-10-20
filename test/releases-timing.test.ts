/** `/releases` names session, releases, rollback and render in Server-Timing (#3260). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { releaseDir } from "../src/release/checkout.ts";
import { recordRelease } from "../src/release/record.ts";
import { proveAll } from "./helpers/verified.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const LIVE = "a".repeat(40);
const KEPT = ["b".repeat(40), "c".repeat(40)];

let root = "";
let app: App;
let servers: Servers;
const was = process.env["FORGE_COMMIT"];

beforeAll(async () => {
  process.env["FORGE_COMMIT"] = LIVE;
  root = mkdtempSync(join(tmpdir(), "forge-releases-timing-"));
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
  const repoId = app.db.query<{ id: string }, []>("SELECT id FROM repo WHERE name='forge'").get()!.id;
  for (const [i, s] of [LIVE, ...KEPT].entries())
    recordRelease(app.db, { sha: s, repoId, pullNumber: i + 1, ok: true, line: "ok" });
  for (const s of KEPT) {
    const dir = releaseDir(root, s);
    mkdirSync(join(dir, "src", "core"), { recursive: true });
    writeFileSync(join(dir, "src", "core", "schema.ts"), "export const migrations = " + JSON.stringify(Array(10_000).fill("SELECT 1")) + ";\n");
  }
  servers = await serve(app);
});
afterAll(() => {
  if (was === undefined) delete process.env["FORGE_COMMIT"];
  else process.env["FORGE_COMMIT"] = was;
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

test("a writer's GET /releases names its phases and has a Roll back button per non-live release", async () => {
  const signin = await fetch(`${servers.url}/signin`, {
    method: "POST",
    headers: { origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    redirect: "manual",
  });
  const cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
  const res = await fetch(`${servers.url}/releases`, { headers: { cookie } });
  const body = await res.text();
  expect(res.status).toBe(200);
  const parts = (res.headers.get("server-timing") ?? "").split(", ");
  for (const name of ["app", "session", "releases", "rollback", "render"])
    expect(parts.find((p) => p.startsWith(`${name};`))).toMatch(/^[a-z]+;dur=\d+\.\d$/);
  expect(body.match(/Roll back/g)?.length).toBe(KEPT.length);
  expect(body).not.toContain(`/releases/${LIVE}/rollback`);
});
