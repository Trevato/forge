/** #10924 round two: the retry is honest when the store is a local directory, the terminal has the same retry, and Home drops a cleared backup at once. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { retryBackup } from "../src/actions/backup_retry.ts";
import { createUser, type User } from "../src/core/users.ts";
import { alarmBackup } from "../src/flow/alarm_backup.ts";
import { recordSnapshotOutcome } from "../src/snapshot/outcome.ts";
import { startSnapshots, type SnapshotsHandle } from "../src/snapshot/service.ts";
import { dirStore } from "../src/snapshot/store.ts";
import { cachedAlarms } from "../src/web/studio/alarm_lines.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp, settleUntil } from "./helpers/tui.ts";

quietLogs();

let dir: string;
let app: App;
let svc: SnapshotsHandle;
let alice: User;
let bob: User;
const identity = (user: User) => ({ sshUsername: user.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-backup-retry-"));
  app = createApp({ dataDir: dir, port: 0 });
  const mk = async (username: string, adminIfFirst: boolean) => {
    const r = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  alice = await mk("alice", true);
  bob = await mk("bob", false);
  svc = startSnapshots(app, dirStore(join(dir, "store")), { version: "t", nightly: false });
}, 30_000);

afterAll(async () => {
  await svc.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("a real snapshot into a local directory does not clear the alarm, and the retry says so", async () => {
  recordSnapshotOutcome(dir, { landed: "old", offBox: true }, new Date(Date.now() - 40 * 3_600_000).toISOString());
  recordSnapshotOutcome(dir, { error: "bucket unreachable" }, new Date(Date.now() - 3 * 3_600_000).toISOString());
  expect(alarmBackup(dir, new Date()).fired).toBe(true);
  const r = await retryBackup(app, alice);
  expect(r.cleared).toBe(false);
  expect(r.says).toContain("It stayed on this machine, so it is not an off-box backup");
  expect(alarmBackup(dir, new Date()).fired).toBe(true);
});

test("a stranger is refused", async () => {
  expect((await retryBackup(app, bob)).refused).toBe("not_found");
});

test("Home's cached alarms drop a backup that has cleared, inside the 30 s", () => {
  const d = dir;
  recordSnapshotOutcome(d, { error: "boom" }, new Date(Date.now() - 3 * 3_600_000).toISOString());
  expect(cachedAlarms(app.db, new Date(), null, d).some((a) => a.key === "backup")).toBe(true);
  recordSnapshotOutcome(d, { landed: "s", offBox: true }, new Date().toISOString());
  expect(cachedAlarms(app.db, new Date(), null, d).some((a) => a.key === "backup")).toBe(false);
});

test("the Valves screen shows the overdue backup and b retries it", async () => {
  recordSnapshotOutcome(dir, { landed: "old", offBox: true }, new Date(Date.now() - 40 * 3_600_000).toISOString());
  recordSnapshotOutcome(dir, { error: "bucket unreachable" }, new Date(Date.now() - 3 * 3_600_000).toISOString());
  const { app: tui } = createForgeApp(app, identity(alice), { terminal: headlessTerminal(160, 24), exitHooks: false });
  tui.start();
  tui.dispatch({ type: "key", key: "k", ctrl: true, alt: false, shift: false });
  for (const ch of "Valves") tui.dispatch({ type: "key", key: ch, ctrl: false, alt: false, shift: false });
  await settleApp(tui);
  tui.dispatch({ type: "key", key: "enter", ctrl: false, alt: false, shift: false });
  await settleUntil(tui, "b retries it now", { timeoutMs: 4_000 });
  tui.dispatch({ type: "key", key: "b", ctrl: false, alt: false, shift: false });
  await settleUntil(tui, "stayed on this machine", { timeoutMs: 8_000 });
  tui.stop?.();
});
