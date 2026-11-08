/**
 * Settings → Subscriptions → "wake": POST /settings/subscriptions/:id/wake
 * puts a resting Claude account back in use. A forge admin's alone, same-origin.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import {
  addSubscription,
  getSubscription,
  restSubscription,
} from "../src/core/subscriptions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { adminCookie } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const KEY = "sk-ant-api03-wake-key-for-the-test-aaaaaaaa";

describe("waking a resting account from Settings", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let admin = "";
  let member = "";
  let id = "";

  const rest = () =>
    restSubscription(app.db, id, new Date(Date.now() + 3_600_000).toISOString(), "weekly limit");
  const resting = () => getSubscription(app.db, id)?.restingUntil ?? null;
  const wake = (target: string, headers: Record<string, string>) =>
    fetch(`${servers.url}/settings/subscriptions/${target}/wake`, {
      method: "POST",
      headers,
      body: new URLSearchParams({}),
      redirect: "manual",
    });
  const pool = async (res: Response): Promise<string> => {
    const flash = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    return (
      await fetch(`${servers.url}/settings/subscriptions`, {
        headers: { cookie: `${admin}; ${flash}` },
      })
    ).text();
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-wake-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    admin = await adminCookie(app, { username: "alice", email: "a@x.test", password: "a-long-wake-passphrase" });
    const bob = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "bob",
      email: "b@x.test",
      password: "a-long-wake-passphrase",
    });
    if (!bob.ok) throw new Error("bob");
    const res = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username: "bob", password: "a-long-wake-passphrase" }),
      redirect: "manual",
    });
    member = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    const made = addSubscription(app.db, dataDir, { name: "starter", token: KEY });
    if (!made.ok) throw new Error("sub");
    id = made.value.id;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an admin wakes a resting account: the flash says so and the pool shows it in use", async () => {
    rest();
    expect(resting()).not.toBeNull();
    const before = await (await fetch(`${servers.url}/settings/subscriptions`, { headers: { cookie: admin } })).text();
    expect(before).toContain("resting until");
    const res = await wake(id, { cookie: admin, origin: servers.url });
    expect(res.status).toBe(303);
    expect(resting()).toBeNull();
    const after = await pool(res);
    expect(after).toContain("In use again.");
    expect(after).not.toContain("resting until");
  });

  test("an unknown id changes nothing and does not crash", async () => {
    rest();
    const res = await wake("no-such-account", { cookie: admin, origin: servers.url });
    expect(res.status).toBe(303);
    expect(resting()).not.toBeNull();
    expect(getSubscription(app.db, "no-such-account")).toBeUndefined();
  });

  test("a non-admin, a signed-out visitor and a cross-origin post are refused; the account stays resting", async () => {
    rest();
    const nonAdmin = await wake(id, { cookie: member, origin: servers.url });
    expect(nonAdmin.status).toBeGreaterThanOrEqual(400);
    expect(resting()).not.toBeNull();
    const anon = await wake(id, { origin: servers.url });
    expect(anon.headers.get("location") ?? "").not.toContain("/settings/subscriptions");
    expect(resting()).not.toBeNull();
    const cross = await wake(id, { cookie: admin, origin: "https://evil.example" });
    expect(cross.status).toBeGreaterThanOrEqual(400);
    expect(resting()).not.toBeNull();
  });
});
