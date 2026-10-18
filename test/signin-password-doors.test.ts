import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import * as users from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { setLimit } from "../src/settings/limits.ts";
import { Session } from "../src/tui/session.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

// Every door that takes a password shares the sign-in windows: with the
// account's window at three, the fourth try is refused before the hash,
// even with the right password.
const PASSWORD = "a-long-family-passphrase";
const TRIES = 3;

let dir = "";
let app: App | undefined;
let servers: Servers | undefined;

afterEach(async () => {
  servers?.stop();
  servers = undefined;
  app = undefined;
  await rm(dir, { recursive: true, force: true });
});

async function forge(): Promise<{ app: App; url: string }> {
  dir = await mkdtemp(join(tmpdir(), "signin-doors-"));
  const made = createApp({ dataDir: dir, port: 0 });
  app = made;
  servers = await serve(made);
  const pat = await seedAdmin(made, { username: "pat", email: "pat@forge.test", password: PASSWORD });
  if (!pat.ok) throw new Error("setup");
  setLimit(made.db, "signin.per_account", TRIES, pat.value.id);
  return { app: made, url: servers.url };
}

const post = (url: string, body: Record<string, string | boolean>): Promise<Response> =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const basic = (url: string, password: string): Promise<Response> =>
  fetch(`${url}/api/v1/user`, { headers: { authorization: `Basic ${btoa(`pat:${password}`)}` } });

describe("password doors share the sign-in windows", () => {
  test("POST /api/v1/sessions refuses the right password after the window fills", async () => {
    const { url } = await forge();
    for (let i = 0; i < TRIES; i++)
      expect((await post(`${url}/api/v1/sessions`, { username: "pat", password: `wrong-${i}` })).status).toBe(401);
    const right = await post(`${url}/api/v1/sessions`, { username: "pat", password: PASSWORD });
    expect(right.status).toBe(429);
    expect(right.headers.get("retry-after")).not.toBeNull();
  });

  test("POST /api/v1/tokens with a password refuses the right password after the window fills", async () => {
    const { url } = await forge();
    for (let i = 0; i < TRIES; i++)
      expect((await post(`${url}/api/v1/tokens`, { username: "pat", password: `wrong-${i}`, name: "x", scope: "ro" })).status).toBe(401);
    const right = await post(`${url}/api/v1/tokens`, { username: "pat", password: PASSWORD, name: "x", scope: "ro", adminConfirm: true });
    expect(right.status).toBe(429);
  });

  test("HTTP Basic with a password refuses the right password after the window fills", async () => {
    const { url } = await forge();
    for (let i = 0; i < TRIES; i++) expect((await basic(url, `wrong-${i}`)).status).toBe(401);
    expect((await basic(url, PASSWORD)).status).toBe(401);
  });

  test("a right password is given back: git sending it on every request is not throttled", async () => {
    const { url } = await forge();
    for (let i = 0; i < TRIES * 3; i++) expect((await basic(url, PASSWORD)).status).toBe(200);
  });

  test("the terminal sign-in refuses the right password after the window fills", async () => {
    const made = (await forge()).app;
    const session = new Session(made, { sshUsername: "pat", remoteAddress: "203.0.113.9" });
    for (let i = 0; i < TRIES; i++) {
      const wrong = await session.signIn("pat", `wrong-${i}`);
      expect(wrong.ok ? "signed in" : wrong.error).toBe("bad_credentials");
    }
    const right = await session.signIn("pat", PASSWORD);
    expect(right.ok ? "signed in" : right.error).toBe("throttled");
  });

  test("the doors count in one window: tries at /signin close the API door", async () => {
    const { url } = await forge();
    for (let i = 0; i < TRIES; i++)
      await fetch(`${url}/signin`, { method: "POST", body: new URLSearchParams({ username: "pat", password: `wrong-${i}` }), redirect: "manual" });
    expect((await post(`${url}/api/v1/sessions`, { username: "pat", password: PASSWORD })).status).toBe(429);
  });
});

describe("no door verifies a password around the windows", () => {
  test("core/users exports no unthrottled password check", () => {
    expect(Object.keys(users)).not.toContain("verifyPassword");
    expect(Object.keys(users)).toContain("verifyPasswordThrottled");
  });

  test("only core/users.ts calls Bun.password.verify", async () => {
    const root = join(import.meta.dir, "..", "src");
    const callers: string[] = [];
    const walk = async (at: string): Promise<void> => {
      for (const entry of await readdir(at, { withFileTypes: true })) {
        const path = join(at, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.name.endsWith(".ts") && (await readFile(path, "utf8")).includes("password.verify("))
          callers.push(path.slice(root.length + 1));
      }
    };
    await walk(root);
    expect(callers).toEqual(["core/users.ts"]);
  });
});
