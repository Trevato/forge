/**
 * POST /api/v1/users asks signupAllowed: past the per-source limit it answers
 * 429 with retry-after and a JSON error, and refuses without making a user.
 * The form asks the same function, so one window serves both.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("API signup throttle", () => {
  const cleanup: Array<() => Promise<void>> = [];
  let app: App;
  let servers: Servers;
  let n = 0;

  beforeEach(async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-signup-throttle-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    cleanup.push(async () => {
      await servers.stop();
      await rm(dataDir, { recursive: true, force: true });
    });
  });
  afterAll(async () => {
    for (const c of cleanup) await c();
  });

  const signup = (name = `person${++n}`) =>
    fetch(`${servers.url.replace("localhost", "127.0.0.1")}/api/v1/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: name,
        email: `${name}@outsider.test`,
        password: "a-good-passphrase",
      }),
    });

  test("the sixth signup from one source is 429 with retry-after, and makes no user", async () => {
    for (let i = 0; i < 5; i++) expect((await signup()).status).toBe(201);
    const refused = await signup("sixth");
    expect(refused.status).toBe(429);
    const wait = Number(refused.headers.get("retry-after"));
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(60);
    expect(((await refused.json()) as { error: string }).error).toBe("rate_limited");
    expect(getUserByName(app.db, "sixth")).toBeUndefined();
  });

  test("a form signup spends the same window the API draws on", async () => {
    const url = servers.url.replace("localhost", "127.0.0.1");
    const form = await fetch(`${url}/signup`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: url },
      body: new URLSearchParams({
        username: "formperson",
        email: "formperson@outsider.test",
        password: "a-good-passphrase",
      }),
      redirect: "manual",
    });
    expect(form.status).toBe(303);
    for (let i = 0; i < 4; i++) expect((await signup()).status).toBe(201);
    expect((await signup()).status).toBe(429);
  });
});
