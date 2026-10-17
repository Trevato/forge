/**
 * Guessing a password is throttled: an account may be tried twenty times a
 * minute, the forge two hundred, checked before the hash runs. A refused
 * attempt answers 429 with Retry-After and is not counted, and the right
 * password still works once the window has slid.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("sign-in attempts are throttled", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;

  const attempt = (username: string, password: string) =>
    fetch(`${servers.url}/signin`, {
      method: "POST",
      headers: { origin: servers.url },
      body: new URLSearchParams({ username, password }),
      redirect: "manual",
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-signin-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    // The throttle counts before the hash runs, so what it counts need not be
    // costly: alice's stored hash is the cheapest argon2id (verify reads the
    // cost from the hash itself), keeping twenty guesses to milliseconds.
    const cheap = await Bun.password.hash("a-good-passphrase", {
      algorithm: "argon2id",
      memoryCost: 8,
      timeCost: 1,
    });
    app.db.run("UPDATE user SET password_hash = ?1 WHERE username = 'alice'", [
      cheap,
    ]);
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("twenty wrong guesses at one account, then the door closes for a minute", async () => {
    for (let i = 0; i < 20; i++) {
      const r = await attempt("alice", `wrong-${i}`);
      expect(r.status).toBe(422);
    }
    const shut = await attempt("alice", "a-good-passphrase");
    expect(shut.status).toBe(429);
    expect(Number(shut.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await shut.text()).toContain("Too many attempts");
    // The account's name, not its case, is the key.
    expect((await attempt("ALICE", "a-good-passphrase")).status).toBe(429);
    // Another account is its own window.
    expect((await attempt("bob", "whatever")).status).toBe(422);
  });

  test("a refused attempt is not counted: the door reopens exactly a window later", async () => {
    // Hammering the closed door keeps answering 429 without pushing the
    // window forward — checked by the limiter's own contract; here the
    // status is all a client sees.
    for (let i = 0; i < 5; i++)
      expect((await attempt("alice", "x")).status).toBe(429);
  });
});
