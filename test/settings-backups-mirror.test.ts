/**
 * Settings → Backups → Off-box mirror: an admin seals and clears the mirror
 * through the page's own forms. Nothing a credential says comes back, a
 * refused destination is a danger flash that saves nothing, and a non-admin or
 * a cross-origin post changes nothing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { mirrorSealedSet } from "../src/snapshot/mirror.ts";
import { adminCookie } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const SECRET = "mirror-s3cr3t-ZZZ-0123456789";
const ACCESS = "AKIAMIRRORKEY";
const GOOD = {
  endpoint: "http://127.0.0.1:9100",
  bucket: "forge-mirror",
  access_key: ACCESS,
  secret_key: SECRET,
};

describe("Settings → Backups mirror", () => {
  let dir = "";
  let app: App;
  let servers: Servers;
  let admin = "";
  let bob = "";

  const post = (path: string, fields: Record<string, string>, cookie: string, origin?: string) =>
    fetch(`${servers.url}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie,
        origin: origin ?? servers.url,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(fields).toString(),
    });

  const flashOf = (res: Response): string => {
    const set = res.headers.getSetCookie().find((c) => c.startsWith("forge_flash=")) ?? "";
    return decodeURIComponent(set.split(";")[0]!.slice("forge_flash=".length));
  };

  const view = async (): Promise<string> =>
    (await fetch(`${servers.url}/settings/backups`, { headers: { cookie: admin } })).text();

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-mirror-page-"));
    delete process.env["FORGE_SNAPSHOT_DIR"];
    app = createApp({ dataDir: dir, port: 0 });
    servers = await serve(app);
    admin = await adminCookie(app, { username: "alice", email: "alice@forge.local" });
    const b = await createUser(app.db, {
      origin: "seed",
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
      trusted: true,
    });
    if (!b.ok) throw new Error("bob");
    bob = `forge_session=${createSession(app.db, b.value.id).token}`;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("a refused destination is a danger flash and saves nothing", async () => {
    const res = await post("/settings/backups/mirror", { ...GOOD, bucket: "NOT A BUCKET" }, admin);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/settings/backups");
    const flash = JSON.parse(flashOf(res));
    expect(flash.tone).toBe("danger");
    expect(flash.message).toContain("The bucket name is 3–63 lowercase letters");
    expect(mirrorSealedSet(app.db)).toEqual([]);
  });

  test("a non-admin and a cross-origin post are refused and change nothing", async () => {
    const asBob = await post("/settings/backups/mirror", GOOD, bob);
    expect(asBob.status).toBe(403);
    const asBobClear = await post("/settings/backups/mirror/clear", {}, bob);
    expect(asBobClear.status).toBe(403);
    const cross = await post("/settings/backups/mirror", GOOD, admin, "https://evil.example");
    expect(cross.status).toBe(403);
    expect(mirrorSealedSet(app.db)).toEqual([]);
  });

  test("an admin seals a mirror, the page shows it set, and no credential comes back", async () => {
    const res = await post("/settings/backups/mirror", GOOD, admin);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/settings/backups");
    const flash = JSON.parse(flashOf(res));
    expect(flash.tone).not.toBe("danger");
    expect(flash.message).toBe("Mirror sealed; it is brought level within the hour.");
    expect(mirrorSealedSet(app.db).sort()).toEqual(
      [
        "SNAPSHOT_MIRROR_S3_ACCESS_KEY",
        "SNAPSHOT_MIRROR_S3_BUCKET",
        "SNAPSHOT_MIRROR_S3_ENDPOINT",
        "SNAPSHOT_MIRROR_S3_SECRET_KEY",
      ],
    );

    const body = await view();
    expect(body.split("set — leave blank to keep").length - 1).toBe(4);
    expect(body).not.toContain(SECRET);
    expect(body).not.toContain(ACCESS);
  });

  test("a cross-origin clear leaves the sealed mirror in place", async () => {
    const res = await post("/settings/backups/mirror/clear", {}, admin, "https://evil.example");
    expect(res.status).toBe(403);
    expect(mirrorSealedSet(app.db)).not.toEqual([]);
  });

  test("clearing says so and the page shows no mirror", async () => {
    const res = await post("/settings/backups/mirror/clear", {}, admin);
    expect(res.status).toBe(303);
    expect(JSON.parse(flashOf(res)).message).toBe("The sealed mirror is cleared.");
    expect(mirrorSealedSet(app.db)).toEqual([]);
    const body = await view();
    expect(body).not.toContain("set — leave blank to keep");
    expect(body).toContain("No off-box mirror");
  });
});
