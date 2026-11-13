/**
 * The mirror's admin routes: a guest and a non-admin are refused and nothing
 * is sealed; a cross-origin post is 403; a seal stores the five names and the
 * page never shows a value; a blank field keeps what was sealed; clear removes
 * the names and, once the pass settles, the board card.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { vitals } from "../src/kernel/vitals.ts";
import { lastMirror, mirrorSealedSet, MIRROR_NAMES, recordMirror, resolveMirror } from "../src/snapshot/mirror.ts";
import { startSnapshots, type SnapshotsHandle } from "../src/snapshot/service.ts";
import { dirStore } from "../src/snapshot/store.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const ENDPOINT = "http://127.0.0.1:1";
const SECRET = "s3cr3t-mirror-xyz";
const ACCESS = "AKIAMIRROREXAMPLE";
const full = { endpoint: ENDPOINT, bucket: "off-box", region: "eu-1", access_key: ACCESS, secret_key: SECRET };

describe("the mirror's admin routes", () => {
  let root = "";
  let app: App;
  let svc: SnapshotsHandle;
  let servers: Servers;

  const login = async (username: string, password: string) => {
    const r = await fetch(`${servers.url}/signin`, {
      method: "POST",
      headers: { origin: servers.url },
      body: new URLSearchParams({ username, password }),
      redirect: "manual",
    });
    return (r.headers.get("set-cookie") ?? "").split(";")[0]!;
  };
  const post = (path: string, body: Record<string, string>, cookie = "", origin = servers.url) =>
    fetch(`${servers.url}/settings/backups${path}`, {
      method: "POST",
      headers: { cookie, origin },
      body: new URLSearchParams(body),
      redirect: "manual",
    });
  const page = async (cookie: string) =>
    (await fetch(`${servers.url}/settings/backups`, { headers: { cookie } })).text();
  const card = () =>
    vitals({ db: app.db, dataDir: app.config.dataDir, signals: app.signals, now: Date.now() }).degraded.filter(
      (d) => d.cause === "mirror",
    );
  const sealed = () => mirrorSealedSet(app.db).sort();

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "forge-mirrorpage-"));
    app = createApp({ dataDir: root, port: 0 });
    for (const [username, password, adminIfFirst] of [
      ["alice", "a-good-passphrase", true],
      ["bob", "another-good-passphrase", false],
    ] as const) {
      const u = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password,
        adminIfFirst,
      });
      if (!u.ok) throw new Error(u.error);
    }
    svc = startSnapshots(app, dirStore(join(root, "store")), {
      version: "t",
      nightly: false,
      // A directory stands in for the bucket whenever the names are sealed: no network.
      mirror: () =>
        resolveMirror({ db: app.db, dataDir: root, bus: app.bus, env: {} }) === undefined
          ? undefined
          : dirStore(join(root, "offbox")),
    });
    servers = await serve(app);
  });
  afterAll(async () => {
    servers.stop();
    await svc.stop();
    app.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("a guest and a non-admin are refused, and nothing is sealed", async () => {
    const bob = await login("bob", "another-good-passphrase");
    for (const path of ["/mirror", "/mirror/clear", "/mirror/now"]) {
      const guest = await post(path, full);
      expect(guest.status).toBe(303);
      expect(guest.headers.get("location")).toContain("/signin");
      expect((await post(path, full, bob)).status).toBe(403);
    }
    expect(sealed()).toEqual([]);
  });

  test("a cross-origin post is refused and seals nothing", async () => {
    const alice = await login("alice", "a-good-passphrase");
    for (const path of ["/mirror", "/mirror/clear", "/mirror/now"])
      expect((await post(path, full, alice, "https://evil.example")).status).toBe(403);
    expect(sealed()).toEqual([]);
  });

  test("an admin seals five names, and the page never shows a value", async () => {
    const alice = await login("alice", "a-good-passphrase");
    expect((await post("/mirror", full, alice)).status).toBe(303);
    expect(sealed()).toEqual([...MIRROR_NAMES].sort());
    const html = await page(alice);
    expect(html).toContain("set — leave blank to keep");
    for (const v of [SECRET, ACCESS, "off-box", "eu-1"]) expect(html).not.toContain(`value="${v}"`);
    expect(html).not.toContain(SECRET);
    expect(html).not.toContain(ACCESS);
  });

  test("a blank field keeps what was sealed, and a changed target drops the old pass", async () => {
    const alice = await login("alice", "a-good-passphrase");
    await svc.mirrorFresh();
    recordMirror(root, { where: "old/bucket", attemptAt: new Date().toISOString(), reachable: true, syncedAt: new Date().toISOString() });
    expect((await post("/mirror", { ...full, endpoint: "", bucket: "other-bucket", access_key: "", secret_key: "" }, alice)).status).toBe(303);
    expect(sealed()).toEqual([...MIRROR_NAMES].sort());
    await svc.mirrorFresh();
    expect(lastMirror(root)?.where).not.toBe("old/bucket");
    expect(lastMirror(root)?.reachable).toBe(true);
  });

  test("clear removes the names, and once the pass settles the card is gone", async () => {
    const alice = await login("alice", "a-good-passphrase");
    recordMirror(root, { where: "x", attemptAt: new Date().toISOString(), reachable: false, failingSince: new Date().toISOString(), error: "refused" });
    expect(card()).toHaveLength(1);
    expect((await post("/mirror/clear", {}, alice)).status).toBe(303);
    expect(sealed()).toEqual([]);
    await svc.mirrorFresh();
    expect(card()).toHaveLength(0);
    expect(lastMirror(root)).toBeUndefined();
    expect(await page(alice)).not.toContain("set — leave blank to keep");
  });
});
