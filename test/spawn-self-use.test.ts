/**
 * A child forge shows its size and use, and its parent's /system shows each
 * child's use against its size (#10853). The figures are checked against a
 * hand calculation: cores = Δusage_usec / Δt_µs, MiB = bytes / 2^20.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { listChildren, listChildrenNow, parseLedger, type Child } from "../src/actions/spawn.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve } from "../src/http/server.ts";
import { cellEnv } from "../src/spawn/cell.ts";
import {
  CGROUP_DIR_ENV,
  childrenUse,
  coresBetween,
  forgetSelfCpu,
  parseMemoryCurrent,
  parseUsageUsec,
  selfUse,
  SIZE_ENV,
  type SelfSource,
} from "../src/spawn/usage.ts";
import { childLines, selfLines } from "../src/tui/screens/system.ts";
import { childrenSection, selfHelp, selfSection } from "../src/web/pages/system.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";
import { createForgeApp, forgeCommands } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { getUserByName } from "../src/core/users.ts";

quietLogs();

const MiB = 1_048_576;
const CG = "/sys/fs/cgroup/forge/cells/f1";

/** A cell child of `size` whose cgroup holds `files`; the clock and the disk are the test's. */
const source = (o: { size?: string; files?: Record<string, string>; now: number; diskBytes?: number; cg?: string }): SelfSource => ({
  env: { ...(o.size === undefined ? {} : { [SIZE_ENV]: o.size }), [CGROUP_DIR_ENV]: o.cg ?? CG },
  dataDir: "/data",
  now: o.now,
  startedAt: 0,
  read: (path) => o.files?.[path],
  rssBytes: () => 300 * MiB,
  cpuUsec: () => 2_000_000,
  disk: () => o.diskBytes,
});

const cgFiles = (memBytes: number, usec: number): Record<string, string> => ({
  [`${CG}/memory.current`]: `${memBytes}\n`,
  [`${CG}/cpu.stat`]: `usage_usec ${usec}\nuser_usec ${usec - 1}\nsystem_usec 1\n`,
});

beforeEach(() => forgetSelfCpu());

describe("the cell tells the child its size", () => {
  test("cellEnv carries the size and the cgroup directory", () => {
    const env = cellEnv({ port: 4000, dataDir: "/d", url: "https://x.test", size: "medium", cgroupDir: CG });
    expect(env[SIZE_ENV]).toBe("medium");
    expect(env[CGROUP_DIR_ENV]).toBe(CG);
    const bare = cellEnv({ port: 4000, dataDir: "/d", url: "https://x.test" });
    expect(bare[SIZE_ENV]).toBeUndefined();
    expect(bare[CGROUP_DIR_ENV]).toBeUndefined();
  });
});

describe("reading the cgroup", () => {
  test("memory.current and cpu.stat parse; junk does not", () => {
    expect(parseMemoryCurrent("1073741824\n")).toBe(1024 * MiB);
    expect(parseMemoryCurrent("max")).toBeUndefined();
    expect(parseMemoryCurrent(undefined)).toBeUndefined();
    expect(parseUsageUsec("usage_usec 123\nuser_usec 100\n")).toBe(123);
    expect(parseUsageUsec("user_usec 100\n")).toBeUndefined();
  });

  test("cores between two readings: 3 s of CPU over 2 s is 1.5 cores; under a second says nothing", () => {
    expect(coresBetween(5_000_000, 8_000_000, 2000)).toBe(1.5);
    expect(coresBetween(0, 1_000_000, 999)).toBeNull();
    expect(coresBetween(9, 1, 5000)).toBeNull();
  });
});

describe("selfUse", () => {
  test("no size in the environment: not a cell child, nothing to show", () => {
    expect(selfUse(source({ now: 10_000 }))).toBeNull();
    expect(selfUse(source({ size: "huge", now: 10_000 }))).toBeNull();
    expect(selfSection(null).text).toBe("");
    expect(selfLines(null)).toEqual([]);
  });

  test("a medium child reads its cgroup: 1 GiB of 4 GiB, cores by hand, disk measuring then 512 MiB", () => {
    // First reading: 5 s of CPU over the 10 s since the start = 0.5 cores.
    const first = selfUse(source({ size: "medium", files: cgFiles(1024 * MiB, 5_000_000), now: 10_000 }))!;
    expect(first.from).toBe("cgroup");
    expect(first.use).toEqual({ kind: "cell", limits: { cpu: 2, memoryMiB: 4096, diskMiB: 10240 }, memoryMiB: 1024, cores: 0.5, diskMiB: null });
    // 2 s later, 3 s more CPU: 1.5 cores.
    const second = selfUse(source({ size: "medium", files: cgFiles(1536 * MiB, 8_000_000), now: 12_000, diskBytes: 512 * MiB }))!;
    expect(second.use.cores).toBe(1.5);
    expect(second.use.memoryMiB).toBe(1536);
    expect(second.use.diskMiB).toBe(512);
    // Under a second later: the last figure again.
    expect(selfUse(source({ size: "medium", files: cgFiles(1536 * MiB, 9_000_000), now: 12_500 }))!.use.cores).toBe(1.5);

    expect(selfLines(second)).toEqual([
      "size medium · 4 GiB, 2 cores, 10 GiB",
      "  memory 1.5 GiB of 4 GiB",
      "  cpu    1.5 of 2 cores",
      "  disk   512 MiB of 10 GiB",
    ]);
    const page = selfSection(second).text;
    expect(page).toContain('data-size="medium"');
    expect(page).toContain('data-from="cgroup"');
    expect(page).toContain("1.5 GiB of 4 GiB");
    expect(page).toContain("1.5 of 2 cores");
    expect(page).toContain("512 MiB of 10 GiB");
    expect(page).toContain("This forge's size: medium</h2>");
    // The note moved behind the page's `?` (#11111): the section is the figures alone.
    expect(page).not.toContain("Disk is measured");
    expect(selfHelp(second)!.text).toContain("Size is set by the forge that made this one. Disk is measured every 30 seconds.");
    expect(page).not.toContain("memory.current");
  });

  test("an unreadable cgroup falls back to this process, and says so", () => {
    const s = selfUse(source({ size: "small", now: 4000, cg: "relative/path" }))!;
    expect(s.from).toBe("process");
    expect(s.use.memoryMiB).toBe(300);
    // 2 s of CPU over 4 s = 0.5 cores.
    expect(s.use.cores).toBe(0.5);
    expect(selfLines(s)[1]).toBe("  memory 300 MiB of 2 GiB (this process alone)");
    expect(selfHelp(s)!.text).toContain("Memory and CPU count this process alone.");
  });
});

const child = (name: string, over: Partial<Child>): Child => ({
  name, url: `https://${name}.test`, bodyId: `b-${name}`, done: true, for: null, apps: [], createdAt: null,
  size: "small", placement: "hosted", placementNote: null, ...over,
});

describe("each child against its size", () => {
  test("finished children only; hosted reads shared, a stopped cell reads not running", () => {
    const rows = childrenUse(
      [child("ada", { size: "large" }), child("bea", { placement: "cell", size: "medium" }), child("cy", { done: false })],
      (id) => `/nowhere/${id}`,
    );
    expect(rows.map((r) => [r.name, r.size, r.use.kind])).toEqual([["ada", "large", "shared"], ["bea", "medium", "idle"]]);
    expect(childLines(rows)).toEqual([
      "Child forges",
      "ada              large · shared with this forge",
      "bea              medium · 4 GiB, 2 cores, 10 GiB",
      "  not running",
    ]);
    // A running cell's three figures are never cut off: they wrap under the size.
    const running = childLines([{ name: "cy", url: "https://cy.test", size: "large", use: { kind: "cell", limits: { cpu: 4, memoryMiB: 8192, diskMiB: 40960 }, memoryMiB: 1536, cores: 0.25, diskMiB: 12595 } }]);
    expect(running.slice(2)).toEqual(["  memory 1.5 GiB of 8 GiB · cpu 0.25 of 4 cores", "  disk 12.3 GiB of 40 GiB"]);
    const html = childrenSection(rows).text;
    expect(html).toContain('data-child="ada"');
    expect(html).toContain("shared with this forge");
    expect(html).toContain('<a href="https://ada.test">ada</a>');
    expect(html).toContain(">not running</span>");
    expect(html).not.toContain("memory not running");
    expect(html).not.toContain('href="/forges"');
    expect(childrenSection([]).text).toBe("");
    expect(childLines([])).toEqual([]);
  });
});

describe("GET /system, both sides", () => {
  let dir: string;
  let app: ReturnType<typeof createApp>;
  let servers: Awaited<ReturnType<typeof serve>>;
  let tok: string;
  let guestTok: string;
  const saved = process.env[SIZE_ENV];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-self-use-"));
    app = createApp({ dataDir: dir, port: 0 });
    servers = await serve(app);
    const r = await createUser(app.db, {
      origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
      password: "a-good-passphrase", adminIfFirst: true,
    });
    if (!r.ok) throw new Error(r.error);
    tok = createToken(app.db, r.value.id, "t", "admin").token;
    const g = await createUser(app.db, {
      origin: "seed", trusted: true, username: "bob", email: "bob@forge.local",
      password: "a-good-passphrase", adminIfFirst: true,
    });
    if (!g.ok) throw new Error(g.error);
    guestTok = createToken(app.db, g.value.id, "t", "admin").token;
    await mkdir(join(dir, "spawn"), { recursive: true });
    await writeFile(join(dir, "spawn", "ada.json"), JSON.stringify({ name: "ada", bodyId: "b-ada", done: true, size: "large", placement: "hosted" }));
    // Not a ledger: no bodyId. Both readers skip it the same way.
    await writeFile(join(dir, "spawn", "bad.json"), JSON.stringify({ name: "bad", done: true }));
  });
  afterAll(async () => {
    saved === undefined ? delete process.env[SIZE_ENV] : (process.env[SIZE_ENV] = saved);
    await servers.stop();
    await rm(dir, { recursive: true, force: true });
  });

  const page = async (t = tok) => (await fetch(servers.url + "/system", { headers: { authorization: `Bearer ${t}` } })).text();

  test("an invalid ledger is skipped alike by the page's reader and the terminal's", async () => {
    expect(parseLedger('{"name":"bad","done":true}')).toBeUndefined();
    expect(parseLedger("not json")).toBeUndefined();
    expect(parseLedger("null")).toBeUndefined();
    expect(parseLedger('{"name":"ok","bodyId":"b","done":false}')?.name).toBe("ok");
    expect((await listChildren(app)).map((c) => c.name)).toEqual(["ada"]);
    expect(listChildrenNow(app).map((c) => c.name)).toEqual(["ada"]);
  });

  test("anyone but the owner gets neither section", async () => {
    process.env[SIZE_ENV] = "small";
    const text = await page(guestTok);
    expect(text).toContain("<h1");
    expect(text).not.toContain('id="sys-children"');
    expect(text).not.toContain('id="sys-self"');
  });

  test("the parent lists its child against its size, and shows no size of its own", async () => {
    delete process.env[SIZE_ENV];
    const text = await page();
    expect(text).toContain('id="sys-children"');
    expect(text).toContain('data-child="ada"');
    expect(text).toContain("large · 8 GiB, 4 cores, 40 GiB");
    expect(text).not.toContain('id="sys-self"');
  });

  test("a child in a cell shows its own size", async () => {
    process.env[SIZE_ENV] = "small";
    const text = await page();
    expect(text).toContain('id="sys-self"');
    expect(text).toContain("This forge's size: small</h2>");
  });

  test("the terminal's System command says both, the same way", async () => {
    process.env[SIZE_ENV] = "small";
    const alice = getUserByName(app.db, "alice")!;
    const { app: tui, session } = createForgeApp(app, { sshUsername: "alice", remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user: alice }, { terminal: headlessTerminal(120, 60), exitHooks: false });
    tui.start();
    forgeCommands(session)(tui.ctx).find((c) => c.id === "system")!.run();
    await settleApp(tui);
    const text = tui.screen.toText();
    tui.stop?.();
    expect(text).toContain("size small · 2 GiB, 1 core, 2 GiB");
    expect(text).toContain("Child forges");
    expect(text).toContain("large · shared with this forge");
  });
});
