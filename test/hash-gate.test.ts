/**
 * Password hashing is bounded (#3015): four argon2 checks at once, and no
 * password past 1024 bytes hashed or set. A full gate answers `throttled`
 * (429 with Retry-After on Basic, the API and the sign-in page) and gives the
 * attempt back to the sign-in windows; an over-long password is refused where
 * it is set, in words, on every surface that sets one.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { signUp, changePassword as changeOwnPassword } from "../src/actions/users.ts";
import { MAX_CONCURRENT_HASHES, MAX_PASSWORD, withHashSlot } from "../src/core/hash-gate.ts";
import { admitSignin } from "../src/core/signin-window.ts";
import { changePassword, createUser, getUserById, verifyPasswordThrottled } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

const LONG = "x".repeat(MAX_PASSWORD + 1);
const GOOD = "a-good-passphrase";

/** Hold every hash slot until the returned function is called. */
function fillGate(): () => Promise<void> {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const holders = Array.from({ length: MAX_CONCURRENT_HASHES }, () => withHashSlot(() => held));
  return async () => {
    release();
    await Promise.all(holders);
  };
}

test("slots beyond the cap are refused at once, and freed after", async () => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const first = withHashSlot(() => held.then(() => 1), 1);
  expect(await withHashSlot(async () => 2, 1)).toBeUndefined();
  release();
  expect(await first).toBe(1);
  expect(await withHashSlot(async () => 3, 1)).toBe(3);
});

test("a slot is freed when the work throws", async () => {
  await withHashSlot(async () => {
    throw new Error("x");
  }, 1).catch(() => {});
  expect(await withHashSlot(async () => 4, 1)).toBe(4);
});

describe("the gate and the cap on a forge", () => {
  let dir: string;
  let app: App;
  let servers: Servers;
  let ginaId: string;
  const basic = (user: string, password: string) =>
    fetch(`${servers.url}/api/v1/user`, {
      headers: { authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}` },
    });
  const form = (path: string, fields: Record<string, string>) =>
    fetch(`${servers.url}${path}`, {
      method: "POST",
      headers: { origin: servers.url },
      body: new URLSearchParams(fields),
      redirect: "manual",
    });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-gate-"));
    app = createApp({ dataDir: dir, port: 0 });
    servers = await serve(app);
    const made = await createUser(app.db, { origin: "seed", trusted: true,
      username: "gina", email: "gina@forge.local", password: GOOD, adminIfFirst: true });
    if (!made.ok) throw new Error(made.error);
    ginaId = made.value.id;
  });
  afterAll(async () => {
    await servers.stop?.();
    await rm(dir, { recursive: true, force: true });
  });

  test("a full gate answers throttled with 1s and gives the window attempt back", async () => {
    const release = fillGate();
    const attempt = { username: "gina", password: GOOD, source: "10.0.0.9" };
    // Far more tries than the per-account window (20/min) allows: each is
    // refused by the gate, so none may be counted against it.
    for (let i = 0; i < 40; i++) {
      const out = await verifyPasswordThrottled(app.db, attempt);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error).toEqual({ reason: "throttled", retryAfter: 1 });
    }
    await release();
    expect(admitSignin(app.db, "gina", "10.0.0.9").admitted).toBe(true);
    expect((await verifyPasswordThrottled(app.db, attempt)).ok).toBe(true);
  });

  test("Basic with the gate full is 429 with Retry-After, not a 401", async () => {
    const release = fillGate();
    const res = await basic("gina", GOOD);
    await release();
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("1");
    expect((await basic("gina", GOOD)).status).toBe(200);
  });

  test("Basic with a password past the cap is a plain 401", async () => {
    const res = await basic("gina", LONG);
    expect(res.status).toBe(401);
    expect(res.headers.get("retry-after")).toBeNull();
  });

  test("a password past the cap is refused where it is set", async () => {
    const made = await createUser(app.db, { origin: "seed", trusted: true,
      username: "long", email: "long@forge.local", password: LONG });
    expect(made.ok ? "ok" : made.error).toBe("password_too_long");
    const changed = await changePassword(app.db, ginaId, LONG);
    expect(changed.ok ? "ok" : changed.error).toBe("password_too_long");
  });

  test("sign-up and the own-password change refuse it too", async () => {
    const signed = await signUp(app, { username: "lena", password: LONG }, { slot: { admitted: true } as never });
    expect(signed.ok ? "ok" : signed.error).toBe("password_too_long");
    const changed = await changeOwnPassword(
      app,
      getUserById(app.db, ginaId),
      { current: GOOD, next: LONG, source: "10.0.0.8" },
    );
    expect(changed.ok ? "ok" : changed.error).toBe("password_too_long");
  });

  test("the sign-up page says so in words", async () => {
    const res = await form("/signup", { username: "mila", password: LONG });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("Use 1024 bytes or fewer.");
  });
});
