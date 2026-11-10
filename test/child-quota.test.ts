/**
 * The child quota (#2981): FORGE_CHILD_* declare what children may hold in
 * total; unset declares nothing, and a spawn past a limit is one sentence.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { heldByChildren, quotaRefusal } from "../src/spawn/quota.ts";
import { SIZES } from "../src/spawn/sizes.ts";
import { usePlacement, useProbe } from "../src/spawn/door.ts";
import { hostedPlacement, memoryBodies } from "../src/spawn/placement.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PASSWORD = "a-long-new-forge-passphrase";
const VARS = ["FORGE_CHILD_CPUS", "FORGE_CHILD_MEMORY_MIB", "FORGE_CHILD_DISK_MIB"];

describe("child quota", () => {
  let dir = "";
  let app: App;
  let servers: Servers;
  let cookie = "";
  const url = (p: string) => `${servers.url}${p}`;
  const clear = () => VARS.forEach((v) => delete process.env[v]);
  const spawn = (name: string, size = "small") =>
    fetch(url("/forges/new"), {
      method: "POST",
      headers: { cookie, origin: "https://forge.test" },
      body: new URLSearchParams([["name", name], ["fresh", "a tiny app"], ["size", size], ["do", "spawn"]]),
      redirect: "manual",
    });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-quota-"));
    app = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
    const a = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "a@x.test",
      password: PASSWORD,
      isAdmin: true,
    });
    if (!a.ok) throw new Error("user");
    usePlacement(app, hostedPlacement({ host: "https://forge.test", store: memoryBodies(), maxChildren: 10 }));
    useProbe(app, () => ({ live: async () => true }) as never);
    servers = await serve(app);
    const res = await fetch(url("/signin"), {
      method: "POST",
      body: new URLSearchParams({ username: "alice", password: PASSWORD }),
      redirect: "manual",
    });
    cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  }, 30_000);

  afterAll(async () => {
    clear();
    servers.stop();
    app.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("unset means no quota: nothing is refused and the page has no sentence", async () => {
    clear();
    expect(quotaRefusal(dir, "large")).toBeUndefined();
    expect(await (await fetch(url("/forges/new"), { headers: { cookie } })).text()).not.toContain("quota-full");
  });

  test("a value that is not a whole number above zero declares nothing", () => {
    expect(quotaRefusal(dir, "large", { FORGE_CHILD_CPUS: "0", FORGE_CHILD_DISK_MIB: "lots" })).toBeUndefined();
  });

  test("set and full: 409 refused with one sentence, and the page says it above the form", async () => {
    clear();
    process.env["FORGE_CHILD_CPUS"] = "1";
    const first = await spawn("first");
    expect(first.status).toBe(201);
    const second = await spawn("second");
    expect(second.status).toBe(409);
    expect(await second.text()).toContain("would pass this host&#39;s child CPU limit (FORGE_CHILD_CPUS=1");
    const page = await (await fetch(url("/forges/new"), { headers: { cookie } })).text();
    expect(page).toMatch(/id="quota-full"[^>]*>[^<]*FORGE_CHILD_CPUS=1/);
    expect(page).toContain('id="new-forge"');
    // The New menu offers the door disabled, with the same sentence.
    const home = await (await fetch(url("/"), { headers: { cookie } })).text();
    expect(home).toContain("FORGE_CHILD_CPUS=1");
    // Field errors still render beside their fields.
    const bad = await fetch(url("/forges/new"), {
      method: "POST",
      headers: { cookie, origin: "https://forge.test" },
      body: new URLSearchParams([["name", "Not A Name"], ["fresh", "x"], ["do", "plan"]]),
    });
    expect(bad.status).toBe(422);
    expect(await bad.text()).toMatch(/id="f-name-err"[^>]*>[^<]*name must be/);
  });

  test("room for small but not large is refused only for large", async () => {
    clear();
    // Room for exactly one more small beside what the ledger already holds, read
    // from the sizes rather than typed, so a resized small keeps the test true.
    const room = heldByChildren(dir).memoryMiB + SIZES.small.memoryMiB;
    expect(SIZES.large.memoryMiB).toBeGreaterThan(SIZES.small.memoryMiB);
    process.env["FORGE_CHILD_MEMORY_MIB"] = String(room);
    expect(quotaRefusal(dir, "small")).toBeUndefined();
    expect(quotaRefusal(dir, "large")).toContain("memory limit");
  });
});
