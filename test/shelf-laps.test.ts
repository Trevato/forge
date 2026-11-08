/** The shelf's laps reach Server-Timing on /, /apps and /:owner (#6178). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let root = "";
let app: App;
let servers: Servers;
let cookie = "";

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-shelf-laps-"));
  app = createApp({ dataDir: root, port: 0 });
  servers = await serve(app);
  const u = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "keeper",
    email: "keeper@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  promote(app.db, u.value);
  cookie = `forge_session=${createSession(app.db, u.value.id).token}; forge_mode=studio`;
  for (const name of ["alpha", "beta"]) {
    const made = await createRepo(app, u.value, { name, visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    insertApp(app.db, { repoId: made.value.id, slug: name, access: "public" });
  }
}, 30_000);
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

async function names(path: string): Promise<string[]> {
  const res = await fetch(`${servers.url}${path}`, {
    headers: path === "/" ? {} : { cookie },
  });
  expect(res.status).toBe(200);
  const header = res.headers.get("server-timing") ?? "";
  return header.split(",").map((p) => p.trim().split(";")[0]!);
}

for (const path of ["/apps", "/keeper"]) {
  test(`GET ${path} names the shelf's laps once each`, async () => {
    const got = await names(path);
    for (const lap of ["records", "runs", "production", "pulls", "rows"])
      expect(got).toContain(`shelf-${lap}`);
    expect(new Set(got).size).toBe(got.length);
  });
}

// The front door's shelf is the cached front page, not `shelfRows`: its two
// stretches are reading the page and drawing the tiles.
test("GET / names the front shelf's read and its tiles once each", async () => {
  const got = await names("/");
  expect(got).toContain("shelf");
  expect(got).toContain("tiles");
  expect(new Set(got).size).toBe(got.length);
});
