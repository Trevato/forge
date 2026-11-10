/**
 * #10856: the forge knows whether a child forge's writable space is a
 * filesystem of its own, binds it into the child's cell, says so on the
 * child's line, and refuses to start a child without one when an admin asks.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { capacityValue, childNeedsOwnFilesystem, setCapacity } from "../src/core/capacity.ts";
import { childDisk, diskWords, gib, mountAt, parseMountinfo, startRefusal, validBodyId, type FsSize } from "../src/spawn/disk_mount.ts";
import { cellSpecFor, launchSpecFor } from "../src/spawn/cell.ts";
import { bootHostedChild, childAwake, resolveHostedChildApp, sleepChild, startRefused, wakeGate } from "../src/spawn/host.ts";
import { childDirOf, spawnForge } from "../src/actions/spawn.ts";
import { hostedPlacement } from "../src/spawn/placement.ts";
import { forgeRow } from "../src/web/pages/forges.ts";
import { forgeLines } from "../src/tui/screens/forges.ts";
import { tool as capacityTool } from "../src/http/mcp/tools/capacity.ts";
import type { ClientRow } from "../src/spawn/clients.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const tmp = mkdtempSync(join(tmpdir(), "disk-mount-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// Two real lines in proc(5)'s shape: the root, and a child's own ext4 at /d/children/c1.
const ROOT = "22 1 259:2 / / rw,relatime shared:1 - ext4 /dev/nvme0n1p2 rw";
const OWN = "731 22 7:3 / /d/children/c1 rw,nosuid,nodev,relatime shared:401 - ext4 /dev/loop3 rw";
// 10 GiB of 4 KiB blocks: 2 621 440 × 4096 = 10 737 418 240 bytes; 655 360 inodes.
const TEN_GIB: FsSize = { bsize: 4096, blocks: 2_621_440, files: 655_360 };
const sized = (fs: FsSize | undefined) => () => fs;

describe("a child's writable space, read from mountinfo", () => {
  test("a mount exactly at <data>/children/<id> is its own filesystem, with its size in bytes and inodes", () => {
    const disk = childDisk({ path: "/d/children/c1", mountinfo: `${ROOT}\n${OWN}\n`, size: sized(TEN_GIB) });
    expect(disk).toEqual({ own: true, path: "/d/children/c1", fsType: "ext4", bytes: 10_737_418_240, inodes: 655_360 });
    expect(diskWords(disk)).toBe("own filesystem, 10 GiB");
  });

  test("without the mount it is the shared disk", () => {
    const disk = childDisk({ path: "/d/children/c1", mountinfo: `${ROOT}\n`, size: sized(TEN_GIB) });
    expect(disk).toEqual({ own: false, path: "/d/children/c1" });
    expect(diskWords(disk)).toBe("shared disk");
  });

  test("a mount above it, beside it or below it is not its own", () => {
    const near = [
      "40 22 7:4 / /d/children rw - ext4 /dev/loop4 rw",
      "41 22 7:5 / /d/children/c10 rw - ext4 /dev/loop5 rw",
      "42 22 7:6 / /d/children/c1/sub rw - ext4 /dev/loop6 rw",
    ].join("\n");
    expect(childDisk({ path: "/d/children/c1", mountinfo: `${ROOT}\n${near}`, size: sized(TEN_GIB) }).own).toBe(false);
  });

  test("a mount whose size cannot be read is not counted as its own", () => {
    expect(childDisk({ path: "/d/children/c1", mountinfo: OWN, size: sized(undefined) }).own).toBe(false);
    expect(childDisk({ path: "/d/children/c1", mountinfo: OWN, size: sized({ bsize: 4096, blocks: 0, files: 0 }) }).own).toBe(false);
  });

  test("octal escapes in a mount point are undone, optional fields skipped, junk lines ignored", () => {
    const text = "50 22 7:7 / /d/my\\040data/children/c1 rw shared:9 master:2 - xfs /dev/loop7 rw\nnot a mount line\n\n";
    const mounts = parseMountinfo(text);
    expect(mounts).toEqual([{ mountPoint: "/d/my data/children/c1", fsType: "xfs" }]);
    expect(mountAt(mounts, "/d/my data/children/c1/")?.fsType).toBe("xfs");
  });

  test("GiB to one place: 1.5 GiB is 1 610 612 736 bytes", () => {
    expect(gib(1_610_612_736)).toBe("1.5");
    expect(gib(10 * 1024 ** 3)).toBe("10");
  });

  test("a body id is one path segment", () => {
    expect(validBodyId("cell-01abc")).toBe(true);
    for (const bad of ["..", ".", "a/b", "", "../x", "a\nb"]) expect(validBodyId(bad)).toBe(false);
  });
});

describe("the child's cell", () => {
  const base = { dir: "/d/children/c1", parentDataDir: "/d", parentHome: "/home/f", parentUrl: "https://f.test", size: "small", port: 4100, label: "forge:kid" } as const;

  test("binds its own filesystem when it has one", () => {
    const spec = cellSpecFor({ ...base, disk: { own: true, path: "/mnt/kids/c1", fsType: "ext4", bytes: 1, inodes: 1 } });
    expect(spec.writable).toEqual(["/mnt/kids/c1"]);
  });

  test("with no mount is exactly what it was", () => {
    expect(cellSpecFor({ ...base, disk: { own: false, path: "/d/children/c1" } })).toEqual(cellSpecFor(base));
    expect(cellSpecFor(base).writable).toEqual([]);
  });
});

describe("children.ownFilesystem", () => {
  const made: App[] = [];
  afterAll(() => {
    for (const app of made) app.close();
  });
  const parentWith = (name: string): App => {
    const dataDir = join(tmp, name);
    const app = createApp({ dataDir, url: "https://forge.test" });
    made.push(app);
    mkdirSync(join(dataDir, "spawn"), { recursive: true });
    mkdirSync(join(dataDir, "children", "body-kid"), { recursive: true });
    writeFileSync(join(dataDir, "spawn", "kid.json"), JSON.stringify({ name: "kid", bodyId: "body-kid", done: true, placement: "hosted" }));
    return app;
  };

  test("the line names the child and says why, and is nothing when one is not required or there is one", () => {
    const own = { own: true, path: "/d/children/c1", fsType: "ext4", bytes: 1, inodes: 1 } as const;
    const shared = { own: false, path: "/d/children/c1" } as const;
    const line = startRefusal("kid", shared, true)!;
    expect(line).toContain("kid was not started");
    expect(line).toContain("not a filesystem of its own");
    expect(line.includes("\n")).toBe(false);
    expect(startRefusal("kid", shared, false)).toBeUndefined();
    expect(startRefusal("kid", own, true)).toBeUndefined();
  });

  test("off by default: a child on the shared disk starts", () => {
    const parent = parentWith("off");
    expect(capacityValue(parent.db, "children.ownFilesystem")).toBe("off");
    expect(startRefused(parent, { name: "kid", bodyId: "body-kid" })).toBeUndefined();
    expect(wakeGate(parent, new Request("https://forge.test/", { headers: { host: "kid--forge.test" } }))).toBeUndefined();
  });

  test("on: a child on the shared disk is refused, its page and its apps answer the line", async () => {
    const parent = parentWith("on");
    setCapacity(parent.db, "children.ownFilesystem", "on", "system");
    expect(childNeedsOwnFilesystem(parent.db)).toBe(true);
    const page = wakeGate(parent, new Request("https://forge.test/", { headers: { host: "kid--forge.test" } }));
    expect(page?.status).toBe(503);
    expect(page?.headers.get("content-type")).toContain("text/plain");
    const said = await page!.text();
    expect(said).toContain("kid was not started");
    expect(said.trim().split("\n")).toHaveLength(1);
    const app = await resolveHostedChildApp(parent, new Request("https://forge.test/", { headers: { host: "shop--kid--forge.test" } }));
    expect(app !== undefined && typeof app === "object" && "refused" in app ? app.refused : "").toContain("kid was not started");
  });

  test("the capacity MCP tool reads and writes it", async () => {
    const parent = parentWith("mcp");
    const made = await createUser(parent.db, { origin: "seed", trusted: true, username: "alice", email: "a@x.invalid", isAdmin: true });
    if (!made.ok) throw new Error("no admin");
    const admin = made.value;
    const ctx = { app: parent, auth: { user: admin, scope: "admin" }, request: new Request("https://forge.test/mcp") } as never;
    const listed = await capacityTool.run(ctx, admin, {});
    expect(JSON.stringify(listed)).toContain("children.ownFilesystem");
    // Read, never matched with an asymmetric matcher: bun's toMatchObject writes the matcher into the
    // object it is given, and this schema is the tool's own, shared with test/mcp-table.test.ts.
    const keys = (capacityTool.inputSchema as { properties: { key: { enum: readonly string[] } } }).properties.key.enum;
    expect([...keys]).toContain("children.ownFilesystem");
    const set = await capacityTool.run(ctx, admin, { key: "children.ownFilesystem", value: "on", dryRun: false });
    expect(set.ok).toBe(true);
    expect(childNeedsOwnFilesystem(parent.db)).toBe(true);
    await capacityTool.run(ctx, admin, { key: "children.ownFilesystem", value: "", dryRun: false });
    expect(childNeedsOwnFilesystem(parent.db)).toBe(false);
  });
});

describe("the child's line", () => {
  const row = (over: Partial<ClientRow>): ClientRow => ({
    name: "kid",
    url: "https://kid--forge.test",
    for: null,
    apps: [],
    sentAt: null,
    made: true,
    claimed: true,
    lastActivityAt: null,
    running: null,
    reach: null,
    link: null,
    attention: null,
    spendTodayUsd: null,
    ceilingUsd: null,
    size: "small",
    use: { kind: "shared" },
    disk: { own: false, path: "/d/children/c1" },
    lastHeartbeatAt: null,
    nextStep: { key: "unreported", words: "has not reported yet", lastTellAt: null },
    ...over,
  });

  test("reads own filesystem, N GiB or shared disk on /forges and in the terminal", () => {
    const own = row({ disk: { own: true, path: "/d/children/c1", fsType: "ext4", bytes: 10 * 1024 ** 3, inodes: 1 } });
    expect(String(forgeRow(own, Date.now()))).toContain(`<span data-disk="own">own filesystem, 10 GiB</span>`);
    expect(String(forgeRow(row({}), Date.now()))).toContain(`<span data-disk="shared">shared disk</span>`);
    expect(forgeLines([own])[0]![1]).toContain("own filesystem, 10 GiB");
    expect(forgeLines([row({})])[0]![1]).toContain("shared disk");
  });

  test("is escaped", () => {
    const html = String(forgeRow(row({ name: `<img src=x onerror=alert(1)>`, for: `"><script>` }), Date.now()));
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>");
    expect(html).toContain("shared disk");
  });
});

describe("what the forge launches and boots", () => {
  const made: App[] = [];
  afterAll(() => {
    for (const app of made) app.close();
  });

  const spawned = async (name: string): Promise<App> => {
    const parent = createApp({ dataDir: join(tmp, name), url: "https://forge.test", port: 0 });
    made.push(parent);
    const admin = await createUser(parent.db, { origin: "seed", trusted: true, username: "alice", email: "a@x.invalid", isAdmin: true });
    if (!admin.ok) throw new Error("user");
    const out = await spawnForge(
      parent,
      admin.value,
      { name: "kid", org: "kid", apps: [], carryBriefs: false, carrySubscriptions: false },
      { catalog: [], briefs: [], subscriptions: [] },
      {
        placement: hostedPlacement({ host: "forge.test" }),
        request: new Request("https://forge.test/spawn", { method: "POST", headers: { origin: "https://forge.test" } }),
        url: new URL("https://forge.test/spawn"),
      },
    );
    if (!out.ok) throw new Error(JSON.stringify(out.error));
    await sleepChild(parent, "kid");
    return parent;
  };

  test("the registry's cell spec binds the child's own filesystem, and binds nothing on the shared disk", async () => {
    const parent = createApp({ dataDir: join(tmp, "launch"), url: "https://forge.test", port: 0 });
    made.push(parent);
    mkdirSync(childDirOf(parent, "cell-kid1"), { recursive: true });
    const real = realpathSync(childDirOf(parent, "cell-kid1"));
    const input = { bodyId: "cell-kid1", name: "kid", size: "small" } as const;
    const at = { port: 4100, parentPort: 4101 };
    const own = launchSpecFor(parent, input, at, `${ROOT}\n731 22 7:3 / ${real} rw - ext4 /dev/loop3 rw\n`);
    expect(own.writable).toEqual([real]);
    expect(launchSpecFor(parent, input, at, `${ROOT}\n`).writable).toEqual([]);
    // The launch path names the cell after the child, not the parent's pod (#10850).
    expect(own.hostname).toBe("kid");
  });

  test("the boot does not open a child on the shared disk when one of its own is required, and opens it when not", async () => {
    const parent = await spawned("boot");
    expect(childAwake(parent, "kid")).toBe(false);
    setCapacity(parent.db, "children.ownFilesystem", "on", "system");
    await bootHostedChild(parent, "kid");
    expect(childAwake(parent, "kid")).toBe(false);
    setCapacity(parent.db, "children.ownFilesystem", "off", "system");
    await bootHostedChild(parent, "kid");
    expect(childAwake(parent, "kid")).toBe(true);
  });
});
