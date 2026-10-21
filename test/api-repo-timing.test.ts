/** `GET /api/v1/repos/:owner/:name` names session, repo, its reads and render in Server-Timing (#3790). */
import { afterAll, beforeAll, expect, test } from "bun:test";
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
  root = mkdtempSync(join(tmpdir(), "forge-api-repo-timing-"));
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

const names = (res: Response): string[] =>
  (res.headers.get("server-timing") ?? "").split(", ").map((p) => p.split(";")[0]!);

test("the read of one repository names its phases", async () => {
  const res = await fetch(`${servers.url}/api/v1/repos/alice/forge`, { headers: { cookie } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { name: string; audience: unknown; counts: unknown };
  expect(body.name).toBe("forge");
  expect(body.audience).toBeDefined();
  expect(body.counts).toBeDefined();
  for (const name of ["app", "session", "repo", "counts", "audience", "render"])
    expect(names(res)).toContain(name);
});

test("a 404 still names session and repo", async () => {
  const res = await fetch(`${servers.url}/api/v1/repos/alice/nope`, { headers: { cookie } });
  expect(res.status).toBe(404);
  expect(names(res)).toContain("session");
  expect(names(res)).toContain("repo");
  expect(names(res)).not.toContain("render");
});
