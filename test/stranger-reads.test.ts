/**
 * API reads without a credential are counted per source (#2917,
 * `http/stranger_reads.ts`): past the limit a stranger is told 429 and when
 * to come back; a token, the liveness probe and the pages are not counted
 * by it.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { setLimit } from "../src/settings/limits.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const LIMIT = 4;
let dataDir: string;
let app: App;
let servers: Servers;
let token = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-stranger-reads-"));
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
  token = createToken(app.db, made.value.id, "t", "ro").token;
  const set = setLimit(app.db, "api.anonymous_per_source", LIMIT, made.value.id);
  if (!set.ok) throw new Error(set.error.message);
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("a stranger's API reads past the limit are refused with a wait; a token's and the probe's are not", async () => {
  const read = (headers: Record<string, string> = {}) =>
    fetch(`${servers.url}/api/v1/health`, { headers });
  for (let i = 0; i < LIMIT; i++) expect((await read()).status).toBe(200);
  const refused = await read();
  expect(refused.status).toBe(429);
  expect(((await refused.json()) as { error: string }).error).toBe("rate_limited");
  expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
  expect(refused.headers.get("x-content-type-options")).toBe("nosniff");
  // A wrong token is still a stranger.
  expect((await read({ authorization: "Bearer not-a-token" })).status).toBe(429);
  // Counted elsewhere, or never: a token, liveness, readiness and a page.
  expect((await read({ authorization: `Bearer ${token}` })).status).toBe(200);
  expect((await fetch(`${servers.url}/healthz`)).status).toBe(200);
  expect((await fetch(`${servers.url}/readyz`)).status).toBe(200);
  expect((await fetch(`${servers.url}/explore`)).status).not.toBe(429);
});
