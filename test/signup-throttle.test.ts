/**
 * The signup form asks signupAllowed: a sixth form post in a minute from one
 * source gets the signup page with the wait and a 429, and no account.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { setLimit } from "../src/settings/limits.ts";

describe("the signup form is throttled", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;

  const post = (username: string) =>
    fetch(`${servers.url}/signup`, {
      method: "POST",
      body: new URLSearchParams({
        username,
        email: `${username}@forge.test`,
        password: "a-good-passphrase",
      }),
      redirect: "manual",
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-signup-throttle-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
  });
  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a sixth sign-up in a minute shows the wait and makes no account", async () => {
    for (let i = 1; i <= 5; i++) expect((await post(`pat-${i}x`)).status).toBe(303);
    const sixth = await post("pat-6x");
    expect(sixth.status).toBe(429);
    expect(Number(sixth.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await sixth.text()).toMatch(/Too many sign-ups from here; try again in (a second|\d+ seconds)/);
    expect(getUserByName(app.db, "pat-6x")).toBeUndefined();
  });

  test("raising signup.per_source lets the next one through", async () => {
    setLimit(app.db, "signup.per_source", 50, getUserByName(app.db, "pat-1x")!.id);
    expect((await post("pat-7x")).status).toBe(303);
  });
});
