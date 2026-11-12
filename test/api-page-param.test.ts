/** A cursor-paged API list refuses `?page=` and `?offset=` with a 400 that says how it pages (#8386). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { openapi, pagesByCursor, ROUTES } from "../src/contract/openapi.ts";
import { pageParamRefused } from "../src/http/cursor_lists.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let cookie = "";
const cells = process.env["FORGE_CELLS"];
const SAYS = { error: "invalid_query", message: "This list pages by cursor: pass next_cursor as ?cursor=." };

beforeAll(async () => {
  process.env["FORGE_CELLS"] = "off";
  dataDir = await mkdtemp(join(tmpdir(), "forge-api-page-param-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error(String(made.error));
  cookie = `forge_session=${createSession(app.db, made.value.id).token}`;
  const repo = await createRepo(app, made.value, { name: "r", visibility: "public" });
  if (!repo.ok) throw new Error(String(repo.error));
});

afterAll(async () => {
  await servers.stop();
  app.close();
  if (cells === undefined) delete process.env["FORGE_CELLS"];
  else process.env["FORGE_CELLS"] = cells;
  await rm(dataDir, { recursive: true, force: true });
});

const get = (path: string) => fetch(`${servers.url}${path}`, { headers: { cookie } });

const lists = [
  "/api/v1/repos/alice/r/issues",
  "/api/v1/repos/alice/r/pulls",
  "/api/v1/repos/alice/r/tags",
  "/api/v1/repos/alice/r/milestones",
  "/api/v1/admin/accounts",
  "/api/v1/admin/people",
  "/api/v1/admin/invites",
  "/api/v1/explore",
];

for (const path of lists) {
  test(`${path} refuses page and offset, and still pages by cursor`, async () => {
    for (const param of ["page=2", "offset=50"]) {
      const res = await get(`${path}?limit=100&${param}`);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual(SAYS);
    }
    expect((await get(`${path}?foo=1`)).status).toBe(200);
  });
}

test("a list that does not page by cursor ignores page", async () => {
  expect((await get("/api/v1/user")).status).not.toBe(400);
});

test("the contract names the 400 on every route the guard covers", () => {
  const doc = openapi("http://x", "0", "admin") as { paths: Record<string, Record<string, { responses: Record<string, unknown> }>> };
  let seen = 0;
  for (const r of ROUTES) {
    const refused = r.method !== "get" ? undefined : pageParamRefused(r.path.replace(/\{(\w+)\}/g, ":$1"), new URLSearchParams("page=2"));
    expect(refused !== undefined).toBe(pagesByCursor(r));
    if (!pagesByCursor(r)) continue;
    seen++;
    expect(doc.paths[r.path]?.[r.method]?.responses["400"]).toBeDefined();
  }
  expect(seen).toBeGreaterThan(10);
});
