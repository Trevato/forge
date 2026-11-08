/**
 * /system in the terminal (#2151): a forge admin who is a person reads the
 * hourly RSS and heap rows and is offered the door; an agent, a member and a
 * guest get neither.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent } from "../src/actions/crew.ts";
import { readHealth } from "../src/actions/health.ts";
import { createApp, type App } from "../src/app.ts";
import { recordMemory } from "../src/boards/memory.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp, forgeCommands, Session } from "../src/tui/forge.ts";
import { setTelemetryGrant } from "../src/actions/telemetry.ts";
import { hasGrant } from "../src/core/telemetry.ts";
import { countRead, resetTelemetryReads } from "../src/system/telemetry_reads.ts";
import { forgeLines, historyLines, readerLines, memoryLines, memoryScreen, systemScreen } from "../src/tui/screens/system.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

const MiB = 1_048_576;
let dir: string;
let app: App;
let carol: User;
let bob: User;
let bot: User;

const identity = (user?: User) => ({
  sshUsername: user?.username ?? "git",
  remoteAddress: "127.0.0.1",
  fingerprint: "SHA256:test",
  user,
});

async function screenText(user?: User): Promise<string> {
  const terminal = headlessTerminal(120, 30);
  const { app: tui, session } = createForgeApp(app, identity(user), { terminal, exitHooks: false });
  tui.start();
  tui.ctx.push(memoryScreen(session, tui.ctx));
  await settleApp(tui);
  const text = tui.screen.toText();
  tui.stop?.();
  return text;
}

const doors = (user?: User): string[] => {
  const { app: tui, session } = createForgeApp(app, identity(user), {
    terminal: headlessTerminal(80, 24),
    exitHooks: false,
  });
  const ids = forgeCommands(session)(tui.ctx).map((c) => c.id);
  tui.stop?.();
  return ids;
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-system-"));
  app = createApp({ dataDir: dir, port: 0 });
  const mk = async (username: string, first = false) => {
    const r = await createUser(app.db, {
      origin: "seed",
      trusted: true, username, email: `${username}@forge.local`,
      password: "a-good-passphrase", adminIfFirst: first,
    });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  carol = await mk("carol", true);
  bob = await mk("bob");
  const made = await createAgent(app, carol, { username: "sysbot", brief: "x" });
  if (!made.ok) throw new Error(String(made.error));
  app.db.query("UPDATE user SET is_admin = 1 WHERE id = ?1").run(made.value.user.id);
  bot = { ...made.value.user, isAdmin: true };
  recordMemory(app.db, 123 * MiB, 45 * MiB, Date.now());
}, 30_000);

afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("tui system memory", () => {
  test("an admin person gets the rows and the door", async () => {
    const lines = memoryLines(new Session(app, identity(carol)));
    expect(lines[0]).toContain("RSS mean");
    expect(lines.join("\n")).toContain("123.0");
    const text = await screenText(carol);
    expect(text).toContain("123.0");
    expect(text).toContain("45.0");
    expect(doors(carol)).toContain("system-memory");
  });

  test("nobody else has rows or the door", async () => {
    for (const who of [bob, bot, undefined]) {
      expect(memoryLines(new Session(app, identity(who)))).toEqual([]);
      expect(doors(who)).not.toContain("system-memory");
      expect(await screenText(who)).not.toContain("123.0");
    }
  });
});

describe("tui system history", () => {
  const put = (at: string, cpu: number, mem: number, load: number) =>
    app.db
      .query("INSERT INTO machine_sample (at, step, target, cpu_cores, cpu_cores_max, memory_bytes, load) VALUES (?1, 15, 'node', ?2, ?2, ?3, ?4)")
      .run(at, cpu, mem, load);

  test("no readings says so, never an empty chart", () => {
    const lines = historyLines(new Session(app, identity(carol)), 6);
    expect(lines.filter((l) => l.includes("no readings yet")).length).toBe(3);
  });

  test("recorded points draw three lines with the latest and the peak; h cycles the window", async () => {
    const t = Date.now();
    put(new Date(t - 120_000).toISOString(), 1, 2 * MiB, 0.5);
    put(new Date(t - 60_000).toISOString(), 4, 8 * MiB, 2);
    put(new Date(t - 30_000).toISOString(), 2, 4 * MiB, 1);
    const lines = historyLines(new Session(app, identity(carol)), 6);
    expect(lines.length).toBe(4);
    expect(lines[1]).toContain("CPU");
    expect(lines[1]).toContain("now 2.00 cores · peak 4.00 cores");
    expect(lines[2]).toContain("now 4.0 MiB");
    expect(lines[3]).toContain("peak 2.00");
    expect(lines.join("\n")).not.toContain("no readings yet");

    const terminal = headlessTerminal(120, 50);
    const { app: tui, session } = createForgeApp(app, identity(carol), { terminal, exitHooks: false });
    tui.start();
    tui.ctx.push(systemScreen(tui.ctx, ["CPU"], session));
    await settleApp(tui);
    const seen = () => tui.screen.toText();
    // the dialog is 72 wide: every row's now and peak words must be on screen, not clipped
    const peaks = () => seen().split("\n").filter((r) => r.includes("peak"));
    expect(seen()).toContain("Last 6 h");
    expect(peaks().length).toBe(3);
    expect(seen()).toContain("peak 4.00 cores");
    expect(seen()).toContain("peak 8.0 MiB");
    for (const hrs of [24, 72, 1, 6]) {
      tui.dispatch({ type: "key", key: "h", ctrl: false, alt: false, shift: false });
      await settleApp(tui);
      expect(seen()).toContain(`Last ${hrs} h`);
      // the 72 h window reads 5-minute points, of which the test recorded none
      expect(peaks().length).toBe(hrs === 72 ? 0 : 3);
      if (hrs === 72) expect(seen()).toContain("no readings yet");
    }
    tui.stop?.();
  });

  test("anyone telemetry_history refuses sees no line", () => {
    for (const who of [bob, undefined]) expect(historyLines(new Session(app, identity(who)), 6)).toEqual([]);
  });
});

describe("tui system telemetry grant", () => {
  const boot = (user: User) => {
    // The refusal is a toast read after a settle; a loaded run must not outlast it.
    const { app: tui, session } = createForgeApp(app, identity(user), {
      terminal: headlessTerminal(120, 50),
      exitHooks: false,
      toastMs: 10 * 60_000,
    });
    tui.start();
    tui.ctx.push(systemScreen(tui.ctx, ["CPU"], session));
    const press = async (...keys: string[]) => {
      for (const key of keys) tui.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
      await settleApp(tui);
    };
    return { tui, press };
  };

  test("an admin grants and takes back after a confirm", async () => {
    const h = boot(carol);
    await settleApp(h.tui);
    expect(h.tui.screen.toText()).toContain("telemetry:read held by: no agent");
    await h.press("g");
    await h.press("enter");
    expect(h.tui.screen.toText()).toContain("grant sysbot telemetry:read? y/n");
    await h.press("left", "enter");
    expect(hasGrant(app.db, bot.id)).toBe(true);
    expect(h.tui.screen.toText()).toContain("telemetry:read held by: sysbot");
    await h.press("g");
    await h.press("enter");
    expect(h.tui.screen.toText()).toContain("take back sysbot telemetry:read? y/n");
    await h.press("enter");
    expect(hasGrant(app.db, bot.id)).toBe(true);
    await h.press("g");
    await h.press("enter");
    await h.press("left", "enter");
    expect(hasGrant(app.db, bot.id)).toBe(false);
    h.tui.stop?.();
  });

  test("anyone the tool refuses is not offered g and is refused in its words", async () => {
    const h = boot(bob);
    await settleApp(h.tui);
    expect(h.tui.screen.toText()).not.toContain("telemetry:read");
    await h.press("g");
    expect(h.tui.screen.toText()).toContain("telemetry:read is a forge admin's to grant");
    expect(h.tui.screen.toText()).not.toContain("Grant telemetry:read to");
    expect(h.tui.screen.toText()).toContain("CPU");
    expect(setTelemetryGrant(app, bob, "sysbot", true)).toEqual({ ok: false, error: "not_found" });
    expect(hasGrant(app.db, bot.id)).toBe(false);
    h.tui.stop?.();
  });

  test("the System command passes the session, so the admin has the line and g", async () => {
    const { app: tui, session } = createForgeApp(app, identity(carol), { terminal: headlessTerminal(120, 50), exitHooks: false });
    tui.start();
    const system = forgeCommands(session)(tui.ctx).find((c) => c.id === "system");
    system!.run();
    await settleApp(tui);
    expect(tui.screen.toText()).toContain("telemetry:read held by:");
    tui.dispatch({ type: "key", key: "g", ctrl: false, alt: false, shift: false });
    await settleApp(tui);
    expect(tui.screen.toText()).toContain("Grant telemetry:read to");
    tui.stop?.();
  });
});

describe("tui system: the forge's own state (#7296)", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const saved = ["FORGE_GUARD_DIR", "FORGE_VERSION", "FORGE_COMMIT"].map((k) => [k, process.env[k]] as const);
  let guard: string;

  beforeAll(async () => {
    guard = await mkdtemp(join(tmpdir(), "forge-tui-system-guard-"));
    process.env["FORGE_GUARD_DIR"] = guard;
    process.env["FORGE_VERSION"] = "v9.8.7";
    process.env["FORGE_COMMIT"] = SHA;
  });

  afterAll(async () => {
    for (const [k, v] of saved) v === undefined ? delete process.env[k] : (process.env[k] = v);
    await rm(guard, { recursive: true, force: true });
  });

  const seed = async (incidents: Record<string, string>) => {
    await writeFile(join(guard, "status.json"), JSON.stringify({ incidents }));
    await writeFile(join(guard, "checkedAt"), new Date().toISOString());
  };

  async function systemText(user: User): Promise<string> {
    const terminal = headlessTerminal(120, 50);
    const { app: tui, session } = createForgeApp(app, identity(user), { terminal, exitHooks: false });
    tui.start();
    forgeCommands(session)(tui.ctx).find((c) => c.id === "system")!.run();
    await settleApp(tui);
    const text = tui.screen.toText();
    tui.stop?.();
    return text;
  }

  test("all well: one line with the version, the short commit and serving; nothing more", async () => {
    await seed({});
    const lines = forgeLines(readHealth(app, carol));
    expect(lines).toEqual(["forge 9.8.7 · 0123456 · serving"]);
    const text = await systemText(carol);
    expect(text).toContain("forge 9.8.7 · 0123456 · serving");
    expect(text).not.toContain("incident");
  });

  test("a seeded incident adds exactly one line, in words", async () => {
    await seed({ down: "the edge answered 502" });
    const lines = forgeLines(readHealth(app, carol));
    expect(lines).toEqual(["forge 9.8.7 · 0123456 · serving", "1 incident: down: the edge answered 502"]);
    expect(await systemText(carol)).toContain("1 incident: down: the edge answered 502");
  });

  test("a blocked rollout and an incident share the one line", async () => {
    await seed({ stuck: "quota refused", "oom:web": "killed" });
    expect(forgeLines(readHealth(app, carol), 20)[1]).toBe("rollout blocked: qu…");
    const lines = forgeLines(readHealth(app, carol));
    expect(lines.length).toBe(2);
    expect(lines[1]).toBe("rollout blocked: quota refused · 1 incident: oom:web: killed");
  });

  test("a stranger's answer, as MCP gives it, never has a second line", async () => {
    await seed({ down: "the edge answered 502" });
    expect(forgeLines(readHealth(app, undefined))).toEqual(["forge 9.8.7 · 0123456 · serving"]);
  });
});

describe("tui system telemetry readers (#9069)", () => {
  test("an admin sees each reader's pace and the flag; anyone else sees nothing", async () => {
    resetTelemetryReads();
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) countRead("flow", "fastbot", t0 - 10_000 + i * 2000);
    countRead("system", "slowbot", t0 - 4000);
    countRead("system", "slowbot", t0 - 1000);
    const lines = readerLines(new Session(app, identity(carol)), t0);
    expect(lines[0]).toContain("Telemetry readers");
    expect(lines.find((l) => l.includes("fastbot"))).toMatch(/flow\s+fastbot\s+5\s+2\.0 s\s+TOO FAST/);
    expect(lines.find((l) => l.includes("slowbot"))).toMatch(/system\s+slowbot\s+2\s+3\.0 s$/);
    for (const who of [bob, bot, undefined]) expect(readerLines(new Session(app, identity(who)), t0)).toEqual([]);

    const terminal = headlessTerminal(120, 60);
    const { app: tui, session } = createForgeApp(app, identity(carol), { terminal, exitHooks: false });
    tui.start();
    tui.ctx.push(systemScreen(tui.ctx, ["CPU"], session));
    await settleApp(tui);
    expect(tui.screen.toText()).toContain("fastbot");
    expect(tui.screen.toText()).toContain("TOO FAST");
    tui.stop?.();
    resetTelemetryReads();
  });
});
