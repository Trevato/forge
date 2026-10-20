/** The terminal palette's search finds exactly what it found before the cache (#3384). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { search } from "../src/actions/search.ts";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { grepCount } from "../src/core/search.ts";
import { getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";

let dir = "";
let app: App;
let servers: Servers;
let token = "";

const api = (path: string, body: unknown) =>
  fetch(servers.url + path, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-search-palette-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const made = await seedAdmin(app, { username: "alice", email: "alice@forge.test", password: "alice-palette-secret" });
  if (!made.ok) throw new Error(made.error);
  token = createToken(app.db, made.value.id, "t", "admin").token;
  for (const [name, visibility] of [["open", "public"], ["closed", "private"]] as const) {
    await api("/api/v1/repos", { name, visibility });
    await api(`/api/v1/repos/alice/${name}/contents`, {
      branch: "main",
      message: "first",
      files: [{ path: `${name}.ts`, content: "const palette = 1;\n" }],
    });
  }
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

// The palette calls this exact action with limit 8 (src/tui/forge.ts).
test("a cached repeat returns the hits the first search did, and a stranger never gets the private ones", async () => {
  const alice = getUserByName(app.db, "alice");
  const ask = (user: typeof alice) => search(app, user, { q: "palette", limit: 8, live: false, withCode: true });
  const cold = await ask(alice);
  expect(cold.code.map((h) => h.repo.name).sort()).toEqual(["closed", "open"]);
  const ran = grepCount();
  expect(await ask(alice)).toEqual(cold);
  expect(grepCount()).toBe(ran);
  const stranger = await ask(undefined);
  expect(stranger.code.map((h) => h.repo.name)).toEqual(["open"]);
});
