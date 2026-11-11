/** Disk readings reach the owner by API and terminal; nobody else files or reads them (#10465). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent } from "../src/actions/crew.ts";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createForgeApp, forgeCommands } from "../src/tui/forge.ts";
import { diskLines } from "../src/tui/screens/disks.ts";
import { diskSummary } from "../src/machines/disk_readings.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const smart = (units: number) => ({
  smartctl: { version: [7, 4] },
  device: { name: "/dev/nvme0", type: "nvme", protocol: "NVMe" },
  model_name: "Samsung SSD 980 PRO 1TB",
  firmware_version: "5B2QGXA7",
  user_capacity: { bytes: 1_000_204_886_016 },
  nvme_smart_health_information_log: {
    critical_warning: 0, temperature: 40, available_spare: 100, available_spare_threshold: 10,
    percentage_used: 1, data_units_written: units, media_errors: 0, power_on_hours: 100,
    unsafe_shutdowns: 2, warning_temp_time: 0, critical_comp_time: 0,
  },
});

let dir: string;
let app: App;
let servers: Servers;
let admin: string;
let ro: string;
let member: string;
let alice: User;
let bob: User;
let bot: User;
let agentToken: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "disk-intake-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!made.ok) throw new Error(made.error);
  alice = made.value;
  admin = createToken(app.db, alice.id, "a", "admin").token;
  ro = createToken(app.db, alice.id, "r", "ro").token;
  const m = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "bob@forge.local", password: "a-good-passphrase" });
  if (!m.ok) throw new Error(m.error);
  bob = m.value;
  member = createToken(app.db, bob.id, "m", "admin").token;
  const agent = await createAgent(app, alice, { username: "diskbot", brief: "x" });
  if (!agent.ok) throw new Error(String(agent.error));
  app.db.query("UPDATE user SET is_admin = 1 WHERE id = ?1").run(agent.value.user.id);
  bot = { ...agent.value.user, isAdmin: true };
  agentToken = createToken(app.db, bot.id, "bot", "admin").token;
}, 60_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const put = (token: string, machine: string, body: unknown) =>
  fetch(`${servers.url}/api/v1/admin/machines/${machine}/disks/nvme0`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const get = (token: string, machine: string) =>
  fetch(`${servers.url}/api/v1/admin/machines/${machine}/disks`, { headers: { authorization: `Bearer ${token}` } });

test("the owner's admin token files a reading and reads the summary", async () => {
  const res = await put(admin, "rack1", { smartctl: smart(1_000), cpu: "AMD EPYC", memoryBytes: 64e9 });
  expect(res.status).toBe(201);
  expect(((await res.json()) as { kind: string }).kind).toBe("nvme");
  // The text form is accepted too.
  expect((await put(admin, "rack1", { smartctl: JSON.stringify(smart(2_000)) })).status).toBe(201);
  const read = await get(ro, "rack1");
  expect(read.status).toBe(200);
  const s = (await read.json()) as { cpu: string; devices: { device: string; bytesWrittenInWindow: number }[] };
  expect(s.cpu).toBe("AMD EPYC");
  expect(s.devices[0]!.device).toBe("nvme0");
  expect(s.devices[0]!.bytesWrittenInWindow).toBe(1_000 * 512_000);
});

test("a refused reading is a 422 and stores nothing; a read-only token cannot write", async () => {
  const before = app.db.query("SELECT COUNT(*) AS n FROM disk_reading").get();
  const bad = await put(admin, "rack2", { smartctl: "not json" });
  expect(bad.status).toBe(422);
  expect(((await bad.json()) as { error: { message?: string } | string }).error).toBeDefined();
  expect((await put(admin, "bad name", { smartctl: smart(1) })).status).toBe(422);
  expect((await put(admin, "rack2", { smartctl: smart(1), cpu: "", memoryBytes: 1 })).status).toBe(422);
  expect((await put(ro, "rack2", { smartctl: smart(1) })).status).toBe(403);
  expect(app.db.query("SELECT COUNT(*) AS n FROM disk_reading").get()).toEqual(before);
});

test("a member, an agent and no one at all file and read nothing", async () => {
  // A member is turned away by the admin gate (403, not_admin) before the handler; an agent admin passes it and the handler hides the route.
  expect((await put(member, "rack3", { smartctl: smart(1) })).status).toBe(403);
  expect((await get(member, "rack1")).status).toBe(403);
  expect((await put(agentToken, "rack3", { smartctl: smart(1) })).status).toBe(404);
  expect((await get(agentToken, "rack1")).status).toBe(404);
  expect((await fetch(`${servers.url}/api/v1/admin/machines/rack1/disks`)).status).toBe(401);
  expect((await fetch(`${servers.url}/api/v1/admin/machines/rack3/disks/nvme0`, { method: "PUT", body: "{}" })).status).toBe(401);
  expect(diskSummary(app.db, "rack3").devices).toEqual([]);
});

const identity = (user?: User) => ({ sshUsername: user?.username ?? "git", remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user });
const doors = (user?: User): string[] => {
  const { app: tui, session } = createForgeApp(app, identity(user), { terminal: headlessTerminal(80, 24), exitHooks: false });
  const ids = forgeCommands(session)(tui.ctx).map((c) => c.id);
  tui.stop?.();
  return ids;
};

test("the Disks screen is the owner's door, and says what the API stored", () => {
  expect(doors(alice)).toContain("disks");
  for (const who of [bob, bot, undefined]) expect(doors(who)).not.toContain("disks");
  const lines = diskLines(diskSummary(app.db, "rack1"));
  expect(lines[0]).toBe("rack1: AMD EPYC, 64 GB");
  expect(lines[1]).toContain("nvme0: Samsung SSD 980 PRO 1TB");
  expect(lines[1]).toContain("0.00 TB");
});

test("a cpu with a control character is refused; model and firmware reach the terminal without theirs", async () => {
  expect((await put(admin, "rack4", { smartctl: smart(1), cpu: "EPYC\u001b]0;pwned\u0007", memoryBytes: 1 })).status).toBe(422);
  expect((await put(admin, "rack4", { smartctl: smart(1), cpu: "EPYC\u009b2J", memoryBytes: 1 })).status).toBe(422);
  const evil = { ...smart(1), model_name: "Samsung\u001b[2J SSD", firmware_version: "5B2\u001b]52;c;eA==\u0007QGXA7" };
  expect((await put(admin, "rack4", { smartctl: evil })).status).toBe(201);
  const lines = diskLines(diskSummary(app.db, "rack4"));
  expect(lines.join("\n")).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
  expect(lines[1]).toContain("Samsung[2J SSD 5B2]52;c;eA==QGXA7");
});
