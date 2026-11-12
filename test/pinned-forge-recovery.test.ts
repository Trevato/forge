/**
 * A pinned forge that fails half-way is recoverable (#8697): a failed create
 * after the delete, a failed first deploy, and a volume made before the droplet
 * all leave a row a retry finishes. The terminal door reaches the same actions.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addAccount, allowWrite, net as cloudNet } from "../src/actions/cloud.ts";
import { deployPinned, net, rollbackPinned, updatePinned } from "../src/actions/pinned.ts";
import { BUN_VERSION, bootConfig } from "../src/cloud/droplet.ts";
import { getPinned } from "../src/core/pinned.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { Session } from "../src/tui/session.ts";
import { entry, pinnedScreen } from "../src/tui/screens/pinned.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const V1 = "a".repeat(40);
const V2 = "b".repeat(40);
const SOURCE = "https://forge.example.org/trevato/forge";

describe("pinned forge recovery", () => {
  let dataDir = "";
  let app: App;
  const calls: string[] = [];
  /** Paths whose next call fails, with the status. */
  const fail = new Map<string, number>();
  let deleted = new Set<string>();

  const admin = () => getUserByName(app.db, "alice")!;
  const input = (over: Record<string, unknown> = {}) => ({
    name: "acme", target: "digitalocean", account: "main", app: "alice/shop", source: SOURCE, version: V1, config: {}, ...over,
  });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-pinned-rec-"));
    app = createApp({ dataDir, port: 0 });
    for (const [username, adminIfFirst] of [["alice", true], ["bob", false]] as const) {
      const made = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@f.test`, password: "a-good-passphrase", adminIfFirst });
      if (!made.ok) throw new Error(made.error);
    }
    cloudNet.fetch = async () => new Response(JSON.stringify({ account: { email: "a@b.c", status: "active" } }), { status: 200 });
    const added = await addAccount(app, admin(), "digitalocean", "main", "dop_v1_9Zq4TxLm7Kp2Vb8nWcR5");
    if (!added.ok) throw new Error(String(added.error));
    allowWrite(app, admin(), "digitalocean", "main", true);
    net.fetch = async (url, init) => {
      const path = new URL(url).pathname;
      const method = init?.method ?? "GET";
      calls.push(`${method} ${path}`);
      const key = `${method} ${path.replace(/\/\d+$/, "")}`;
      const status = fail.get(key);
      if (status !== undefined) { fail.delete(key); return new Response("{}", { status }); }
      if (path === "/v2/volumes") return new Response(JSON.stringify({ volume: { id: "vol-9" } }), { status: 201 });
      if (method === "DELETE") {
        if (deleted.has(path)) return new Response("{}", { status: 404 });
        deleted.add(path);
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ droplet: { id: 2000 + calls.length } }), { status: 202 });
    };
  });

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a failed first deploy keeps its volume, and the same name deploys again reusing it", async () => {
    fail.set("POST /v2/droplets", 500);
    const first = await deployPinned(app, admin(), input());
    expect(first.ok).toBe(false);
    // The volume id was recorded before the droplet was asked for.
    expect(getPinned(app.db, "acme")).toMatchObject({ state: "failed", remote: "", volume: "vol-9" });
    calls.length = 0;
    const again = await deployPinned(app, admin(), input());
    expect(again.ok).toBe(true);
    expect(calls).toEqual(["POST /v2/droplets"]);
    expect(getPinned(app.db, "acme")).toMatchObject({ state: "running", volume: "vol-9" });
    // A running forge still owns its name.
    expect(await deployPinned(app, admin(), input())).toMatchObject({ ok: false, error: "A pinned forge has that name already." });
  });

  test("an Update whose create fails after the delete can be rolled back or tried again", async () => {
    fail.set("POST /v2/droplets", 500);
    expect((await updatePinned(app, admin(), "acme", { version: V2 })).ok).toBe(false);
    expect(getPinned(app.db, "acme")).toMatchObject({ state: "failed", remote: "", version: V2 });
    calls.length = 0;
    // The old droplet is not deleted a second time.
    const back = await rollbackPinned(app, admin(), "acme");
    expect(back.ok).toBe(true);
    expect(calls).toEqual(["POST /v2/droplets"]);
    expect(getPinned(app.db, "acme")).toMatchObject({ state: "running", version: V1 });
  });

  test("a droplet already gone (404) counts as deleted", async () => {
    app.db.run("UPDATE pinned_forge SET remote = '777' WHERE name = 'acme'");
    deleted.add("/v2/droplets/777");
    expect((await updatePinned(app, admin(), "acme", { version: V2 })).ok).toBe(true);
    expect(getPinned(app.db, "acme")).toMatchObject({ state: "running", version: V2 });
  });

  test("a failed forge may be told the version it already has, to finish the replacement", async () => {
    app.db.run("UPDATE pinned_forge SET state = 'failed', remote = '' WHERE name = 'acme'");
    expect((await updatePinned(app, admin(), "acme", { version: V2 })).ok).toBe(true);
    expect(getPinned(app.db, "acme")?.state).toBe("running");
  });

  test("the boot script installs the Bun version it names, not whatever is latest", () => {
    const script = bootConfig({ name: "acme", source: SOURCE, version: V1, config: {} });
    expect(script).toContain(`bash -s "bun-v${BUN_VERSION}"`);
    expect(BUN_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("terminal: the palette offers Pinned forges to an admin only; d, u and r reach the actions", async () => {
    const bob = new Session(app, { sshUsername: "t", remoteAddress: "127.0.0.1", user: getUserByName(app.db, "bob")! });
    const alice = new Session(app, { sshUsername: "t", remoteAddress: "127.0.0.1", user: admin() });
    expect(entry.offered(bob)).toBe(false);
    expect(entry.offered(alice)).toBe(true);

    const pushed: any[] = [];
    const ctx = { push: (s: unknown) => pushed.push(s), invalidate() {}, pop() {}, toast() {}, setCursor() {} } as never;
    const key = (s: { key?: (e: never) => boolean }, k: string) => s.key?.({ type: "key", key: k, ctrl: false, alt: false, shift: false } as never);
    const refused = pinnedScreen(bob, ctx);
    for (const k of ["d", "u", "r"]) key(refused, k);
    expect(pushed).toEqual([]);

    const screen = pinnedScreen(alice, ctx);
    key(screen, "d");
    expect(pushed).toHaveLength(1);
    // r rolls back the forge under the cursor: one action, recorded.
    const before = getPinned(app.db, "acme")!.version;
    key(screen, "r");
    await new Promise((r) => setTimeout(r, 50));
    expect(getPinned(app.db, "acme")!.version).not.toBe(before);
  });

  test("terminal: the screen follows the bus while it is on the stack", async () => {
    const alice = new Session(app, { sshUsername: "t", remoteAddress: "127.0.0.1", user: admin() });
    let invalidated = 0;
    const ctx = { push() {}, invalidate: () => invalidated++ } as never;
    const abort = new AbortController();
    await pinnedScreen(alice, ctx).load!(abort.signal);
    const n = invalidated;
    await updatePinned(app, admin(), "acme", { version: V2 });
    await new Promise((r) => setTimeout(r, 120));
    expect(invalidated).toBeGreaterThan(n);
    abort.abort();
  });
});
