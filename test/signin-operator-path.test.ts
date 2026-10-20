/**
 * The forge-wide sign-in window cannot lock out the operator's passkey door:
 * password guessing fills the window, the passkey door still answers, and a
 * flood of challenges from many sources cannot evict one a quiet source holds.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { challenges } from "../src/auth/webauthn.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { setLimit } from "../src/settings/limits.ts";

let dataDir: string;
let app: App;
let servers: Servers;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-operator-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const a = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!a.ok) throw new Error(a.error);
  const set = setLimit(app.db, "signin.per_forge", 3, "seed");
  if (!set.ok) throw new Error("limit");
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const post = (path: string, body: string | URLSearchParams, type?: string) =>
  fetch(`${servers.url}${path}`, {
    method: "POST",
    headers: { origin: servers.url, ...(type ? { "content-type": type } : {}) },
    body,
    redirect: "manual",
  });
const password = (username: string) => post("/signin", new URLSearchParams({ username, password: "wrong" }));

test("a full forge-wide window refuses a password but not the passkey endpoints", async () => {
  for (let i = 0; i < 3; i++) expect((await password(`victim${i}`)).status).toBe(422);
  expect((await password("alice")).status).toBe(429);
  const options = await post("/signin/passkey/options", "{}", "application/json");
  expect(options.status).toBe(200);
  const assertion = await post("/signin/passkey", "{}", "application/json");
  expect(assertion.status).toBe(401);
});

test("many sources cannot evict the challenge a quiet source holds", () => {
  const c = challenges(60_000, () => 0, 50, 5);
  const operator = c.issue("operator");
  for (let i = 0; i < 500; i++) c.issue(`source-${i % 40}`);
  expect(c.consume(operator)).toBe(true);
});

test("one source holds a bounded number of challenges, oldest first", () => {
  const c = challenges(60_000, () => 0, 1000, 3);
  const first = c.issue("s");
  c.issue("s");
  c.issue("s");
  c.issue("s");
  expect(c.consume(first)).toBe(false);
});

test("one source's flood of signup options does not spend another source's challenge", async () => {
  const { store } = await import("../src/web/pages/passkeys.ts");
  setLimit(app.db, "signin.per_forge", null, "seed");
  setLimit(app.db, "signin.per_account", 200, "seed");
  setLimit(app.db, "signin.per_source", 200, "seed");
  const quiet = store(app).signup.issue("another-source");
  for (let i = 0; i < 25; i++) {
    const r = await post("/signup/passkey/options", JSON.stringify({ username: `flood${i}`, email: `f${i}@forge.local` }), "application/json");
    expect(r.status).toBe(200);
  }
  expect(store(app).signup.consume(quiet)).toBe(true);
});
