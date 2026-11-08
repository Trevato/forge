/**
 * POST /settings/cloud/verify, posted the way the page does: a forge admin
 * verifies an account against a stubbed provider and is told the result; a
 * provider that answers 401 is explained in words, with no key and no raw
 * provider body; a non-admin and a cross-origin post are refused before any
 * provider call.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addAccount, net } from "../src/actions/cloud.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const TOKEN = "ghp_verify9Zq4TxLm7Kp2Vb8nWcR5";
const RAW = "raw-provider-body-bad-credentials-7731";
let mode: "ok" | "unauthorized" = "ok";
let calls = 0;
net.fetch = async () => {
  calls++;
  return mode === "ok"
    ? new Response(JSON.stringify({ login: "octo" }), { status: 200 })
    : new Response(JSON.stringify({ message: RAW }), { status: 401 });
};

describe("POST /settings/cloud/verify", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-cloud-verify-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    for (const [username, adminIfFirst] of [["alice", true], ["bob", false]] as const) {
      const made = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@f.test`, password: "a-good-passphrase", adminIfFirst });
      if (!made.ok) throw new Error(made.error);
    }
    const added = await addAccount(app, getUserByName(app.db, "alice")!, "github", "main", TOKEN);
    if (!added.ok) throw new Error(added.error);
  });
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const login = async (username: string) =>
    ((await fetch(`${servers.url}/signin`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
      body: new URLSearchParams({ username, password: "a-good-passphrase" }),
    })).headers.get("set-cookie") ?? "").split(";")[0] ?? "";

  const verify = (cookie: string, origin: string = servers.url) =>
    fetch(`${servers.url}/settings/cloud/verify`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin },
      body: new URLSearchParams({ provider: "github", name: "main" }),
    });

  /** Follow the redirect with the flash cookie, as a browser does. */
  const landing = async (cookie: string, res: Response): Promise<string> => {
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/settings/cloud");
    const flash = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    return await (await fetch(`${servers.url}/settings/cloud`, { headers: { cookie: `${cookie}; ${flash}` } })).text();
  };

  test("an admin verifies an account that works and is told so", async () => {
    mode = "ok";
    const cookie = await login("alice");
    const before = calls;
    const page = await landing(cookie, await verify(cookie));
    expect(calls).toBeGreaterThan(before);
    expect(page).toContain("GitHub token belongs to octo");
    expect(page).not.toContain(TOKEN);
  });

  test("a provider that answers 401 is explained in words, without key or raw body", async () => {
    mode = "unauthorized";
    const cookie = await login("alice");
    const res = await verify(cookie);
    expect(res.headers.get("set-cookie") ?? "").not.toContain(TOKEN);
    const page = await landing(cookie, res);
    expect(page).toContain("The provider did not accept that credential.");
    expect(page).not.toContain(TOKEN);
    expect(page).not.toContain(RAW);
    expect(page).not.toContain("answered 401");
  });

  test("a non-admin and a cross-origin post are refused, and no provider call is made", async () => {
    mode = "ok";
    const bob = await login("bob");
    const alice = await login("alice");
    const before = calls;
    expect((await verify(bob)).status).toBe(404);
    expect((await verify(alice, "https://evil.example")).status).toBe(403);
    const anon = await verify("");
    expect(anon.headers.get("location") ?? "").not.toBe("/settings/cloud");
    expect(calls).toBe(before);
  });
});
