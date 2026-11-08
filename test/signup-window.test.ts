import { afterAll, afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { SignupSlot, signupWindow, waitText } from "../src/actions/signup-window.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve } from "../src/http/server.ts";
import { setLimit } from "../src/settings/limits.ts";

const T0 = Date.UTC(2031, 0, 1);
const dirs: string[] = [];

async function fresh(options: Partial<Parameters<typeof createApp>[0]> = {}): Promise<App> {
  const dir = await mkdtemp(join(tmpdir(), "forge-signup-window-"));
  dirs.push(dir);
  return createApp({ dataDir: dir, port: 0, ...options });
}

/** An admin to sign the limit changes. */
async function actorOf(app: App): Promise<string> {
  const made = await createUser(app.db, {
    origin: "seed",
    username: "olive",
    email: "olive@f.dev",
    password: "a-long-family-passphrase",
    trusted: true,
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error(made.error);
  return made.value.id;
}

async function limits(app: App, source: number, forge: number): Promise<void> {
  const actor = await actorOf(app);
  for (const [key, value] of [
    ["signup.per_source", source],
    ["signup.per_forge", forge],
  ] as const) {
    const set = setLimit(app.db, key, value, actor);
    if (!set.ok) throw new Error(set.error.message);
  }
}

afterEach(() => setSystemTime());
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

describe("the window", () => {
  test("a source over its count waits; another source is let in; a refused try is not counted", async () => {
    const app = await fresh();
    await limits(app, 3, 100);
    setSystemTime(new Date(T0));
    for (let i = 0; i < 3; i++) expect(signupWindow(app, "203.0.113.5")).toBeUndefined();

    setSystemTime(new Date(T0 + 10_000));
    const wait = signupWindow(app, "203.0.113.5");
    expect(wait).toBe(50);
    expect(waitText(wait!)).toBe("Too many attempts. Try again in 50 seconds.");
    expect(waitText(1)).toBe("Too many attempts. Try again in a second.");
    expect(signupWindow(app, "203.0.113.6")).toBeUndefined();

    // Hammering the closed door neither lengthens the wait nor is counted.
    for (let t = 11_000; t < 40_000; t += 1_000) {
      setSystemTime(new Date(T0 + t));
      expect(signupWindow(app, "203.0.113.5")).toBeDefined();
    }
    setSystemTime(new Date(T0 + 60_001));
    for (let i = 0; i < 3; i++) expect(signupWindow(app, "203.0.113.5")).toBeUndefined();
    expect(signupWindow(app, "203.0.113.5")).toBeDefined();
  });

  test("the forge-wide window refuses once it is spent, whoever asks", async () => {
    const app = await fresh();
    await limits(app, 5, 2);
    setSystemTime(new Date(T0));
    expect(signupWindow(app, "198.51.100.1")).toBeUndefined();
    expect(signupWindow(app, "198.51.100.2")).toBeUndefined();
    expect(signupWindow(app, "198.51.100.3")).toBe(60);
    setSystemTime(new Date(T0 + 60_000));
    expect(signupWindow(app, "198.51.100.3")).toBeUndefined();
  });

  test("an IPv6 source is counted by its /64", async () => {
    const app = await fresh();
    await limits(app, 1, 100);
    setSystemTime(new Date(T0));
    expect(signupWindow(app, "2001:db8:1:2::1")).toBeUndefined();
    expect(signupWindow(app, "2001:db8:1:2:ffff::9")).toBeDefined();
    expect(signupWindow(app, "2001:db8:1:3::1")).toBeUndefined();
  });
});

describe("a real sign-up route", () => {
  test("an X-Forwarded-For header the client typed does not change the window counted", async () => {
    // Only 10.42/16 is a proxy here; the test client on loopback is not.
    const app = await fresh({ trustedProxies: ["10.42.0.0/16"] });
    await limits(app, 1, 100);
    const servers = await serve(app);
    try {
      setSystemTime(new Date(T0));
      const attempt = (name: string, forwarded: string) =>
        fetch(`${servers.url}/signup`, {
          method: "POST",
          redirect: "manual",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            origin: servers.url,
            "x-forwarded-for": forwarded,
          },
          body: new URLSearchParams({
            username: name,
            email: `${name}@f.dev`,
            password: "a-long-family-passphrase",
          }),
        });
      const first = await attempt("amy", "198.51.100.1");
      expect(first.status).not.toBe(429);
      expect(getUserByName(app.db, "amy")).toBeDefined();
      // Another typed address is still the same socket: refused, no account.
      const second = await attempt("ben", "198.51.100.2");
      expect(second.status).toBe(429);
      expect(Number(second.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(getUserByName(app.db, "ben")).toBeUndefined();
    } finally {
      servers.stop();
    }
  });
});

describe("the slot", () => {
  test("createUser from a stranger's door without a slot makes no account", async () => {
    const app = await fresh();
    const count = () => app.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM user").get()!.n;
    const before = count();
    for (const origin of ["signup", "passkey"] as const) {
      await expect(
        createUser(app.db, {
          origin,
          username: "mallory",
          email: "m@f.dev",
          password: "a-long-family-passphrase",
        } as never),
      ).rejects.toThrow();
    }
    expect(count()).toBe(before);
    expect(getUserByName(app.db, "mallory")).toBeUndefined();
  });

  test("a slot makes one account and cannot be reused", async () => {
    const app = await fresh();
    setSystemTime(new Date(T0));
    const slot = SignupSlot.take(app, "203.0.113.9");
    if (typeof slot === "number") throw new Error("window spent");
    expect(slot.spent).toBe(false);
    const made = await createUser(app.db, {
      origin: "signup",
      slot,
      username: "amy",
      email: "amy@f.dev",
      password: "a-long-family-passphrase",
    });
    expect(made.ok).toBe(true);
    expect(slot.spent).toBe(true);
    await expect(
      createUser(app.db, {
        origin: "signup",
        slot,
        username: "ben",
        email: "ben@f.dev",
        password: "a-long-family-passphrase",
      }),
    ).rejects.toThrow("one account");
    expect(getUserByName(app.db, "ben")).toBeUndefined();
  });

  test("a spent window gives the seconds to wait instead of a slot", async () => {
    const app = await fresh();
    await limits(app, 1, 100);
    setSystemTime(new Date(T0));
    expect(SignupSlot.take(app, "203.0.113.10")).toBeInstanceOf(SignupSlot);
    expect(SignupSlot.take(app, "203.0.113.10")).toBe(60);
  });
});
