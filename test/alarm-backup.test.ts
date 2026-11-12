/** The off-box backup alarm (#10924): raises at 26 h, names the last failure's cause, clears when a backup lands; /flow draws the card with one retry. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { alarmBackup } from "../src/flow/alarm_backup.ts";
import { firedAlarms } from "../src/flow/alarms.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { recordSnapshotOutcome } from "../src/snapshot/outcome.ts";

const NOW = new Date("2026-11-10T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

let dir: string;
let app: App;
let servers: Servers;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-alarm-backup-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  for (const [username, adminIfFirst] of [["alice", true], ["bob", false]] as const) {
    const u = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst });
    if (!u.ok) throw new Error(u.error);
  }
});
afterAll(async () => {
  servers.stop();
  await rm(dir, { recursive: true, force: true });
});

const fresh = () => mkdtemp(join(tmpdir(), "forge-ab-"));

describe("alarmBackup", () => {
  test("says nothing for a forge that has neither sent a copy off the box nor failed to", async () => {
    expect(alarmBackup(await fresh(), NOW).fired).toBe(false);
  });

  test("raises past 26 h with the cause line, and not at 25 h", async () => {
    const d = await fresh();
    recordSnapshotOutcome(d, { landed: "s1", offBox: true }, hoursAgo(25));
    expect(alarmBackup(d, NOW).fired).toBe(false);
    recordSnapshotOutcome(d, { error: "S3 PUT refused: 403 AccessDenied\nstack…" }, hoursAgo(1));
    const late = new Date(NOW.getTime() + 2 * 3_600_000);
    const a = alarmBackup(d, late);
    expect(a.fired).toBe(true);
    expect(a.since).toBe(new Date(Date.parse(hoursAgo(25)) + 26 * 3_600_000).toISOString());
    expect(a.cause).toBe("The snapshot failed: S3 PUT refused: 403 AccessDenied");
    expect(a.says).toBe("The newest off-box backup is 27 h old. The snapshot failed: S3 PUT refused: 403 AccessDenied");
  });

  test("a failure with nothing ever off the box raises from the failure", async () => {
    const d = await fresh();
    recordSnapshotOutcome(d, { error: "no route to bucket" }, hoursAgo(3));
    const a = alarmBackup(d, NOW);
    expect(a.fired).toBe(true);
    expect(a.since).toBe(hoursAgo(3));
    expect(a.says).toBe("No off-box backup has landed. The snapshot failed: no route to bucket");
  });

  test("clears when a backup lands off the box", async () => {
    const d = await fresh();
    recordSnapshotOutcome(d, { landed: "s1", offBox: true }, hoursAgo(40));
    recordSnapshotOutcome(d, { error: "boom" }, hoursAgo(10));
    expect(alarmBackup(d, NOW).fired).toBe(true);
    recordSnapshotOutcome(d, { landed: "s2", offBox: true }, hoursAgo(0.5));
    expect(alarmBackup(d, NOW).fired).toBe(false);
  });

  test("firedAlarms carries it once given the data directory", async () => {
    const d = await fresh();
    recordSnapshotOutcome(d, { error: "boom" }, hoursAgo(3));
    expect(firedAlarms(app.db, NOW, { dataDir: d }).some((a) => a.key === "backup")).toBe(true);
    expect(firedAlarms(app.db, NOW, { dataDir: d, publicOnly: true }).some((a) => a.key === "backup")).toBe(false);
  });
});

describe("/flow backup card", () => {
  const login = async (username: string) => {
    const res = await fetch(`${servers.url}/signin`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url }, body: new URLSearchParams({ username, password: "a-good-passphrase" }) });
    return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  };
  const retry = (cookie: string, origin = servers.url) =>
    fetch(`${servers.url}/flow/backup/retry`, { method: "POST", redirect: "manual", headers: { cookie, origin, "content-type": "application/x-www-form-urlencoded" }, body: "" });

  test("draws the cause and one retry while overdue, and nothing once cleared", async () => {
    const cookie = await login("alice");
    recordSnapshotOutcome(dir, { error: "bucket unreachable" }, hoursAgo(3));
    const text = await (await fetch(`${servers.url}/flow`, { headers: { cookie } })).text();
    expect(text).toContain("No off-box backup has landed");
    expect(text).toContain("The snapshot failed: bucket unreachable");
    expect(text.match(/action="\/flow\/backup\/retry"/g)?.length).toBe(1);
    recordSnapshotOutcome(dir, { landed: "s9", offBox: true }, new Date().toISOString());
    const after = await (await fetch(`${servers.url}/flow`, { headers: { cookie } })).text();
    expect(after).not.toContain("/flow/backup/retry");
  });

  test("retry answers an admin with a flash back to /flow, and refuses a stranger and a foreign origin", async () => {
    const res = await retry(await login("alice"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/flow");
    expect((await retry(await login("bob"))).status).toBe(404);
    expect((await retry(await login("alice"), "https://evil.example")).status).toBeGreaterThanOrEqual(400);
  });
});
