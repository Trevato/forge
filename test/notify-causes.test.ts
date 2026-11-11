/**
 * The vitals causes the pager owns (`errors`, `internal`, `queue:*`, `disk`)
 * page once they have held five minutes and say Recovered once they have
 * been gone five; every other cause is left to whoever already pages it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { seedFirstSeen } from "../src/snapshot/verdict.ts";
import { DOMAINS } from "../src/kernel/domains.ts";
import { drillCommand } from "../src/kernel/domain_drill.ts";
import { recordDrill } from "../src/core/domain_drills.ts";
import { createUser } from "../src/core/users.ts";
import { owned } from "../src/crew/incidents.ts";
import { domainDrillLines, setNotifyUrl, startNotifier, type Notifier } from "../src/crew/notify.ts";

const MIN = 60_000;

describe("owned causes", () => {
  test("an explicit list", () => {
    for (const c of ["errors", "internal", "disk", "disk-floor", "release", "queue:check", "queue:run"])
      expect(owned(c)).toBe(true);
    for (const c of ["drill", "mirror", "stuck:r1", "red:r1", "snapshots", "budget:r1", "shared:r:t"])
      expect(owned(c)).toBe(false);
  });
});

describe("the cause pager", () => {
  let dataDir: string;
  let app: App;
  let notifier: Notifier;
  let clock = 1_000_000;
  let causes: string[] = [];
  const posts: string[] = [];

  async function boot(): Promise<void> {
    notifier = startNotifier(app, {
      forgeUrl: "https://forge.example.test",
      now: () => clock,
      drainingSince: () => null,
      causes: () => causes.map((cause) => ({ cause, sentence: `${cause} is bad` })),
      send: async (_u, body) => {
        posts.push(body);
        return true;
      },
    });
    await notifier.settled();
  }
  const at = async (min: number): Promise<void> => {
    clock += min * MIN;
    await notifier.tick();
  };

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-causes-"));
    app = createApp({ dataDir, port: 0 });
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    setNotifyUrl(app.db, made.value.id, "https://ntfy.example.test/root-topic");
    posts.length = 0;
    clock = 1_000_000;
    causes = [];
    await boot();
  });
  afterEach(async () => {
    await notifier.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a flap pages once; six minutes gone says Recovered once", async () => {
    causes = ["errors"];
    await at(0);
    await at(4);
    expect(posts).toHaveLength(0);
    await at(2);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("errors is bad");
    causes = [];
    await at(1);
    causes = ["errors"];
    await at(1);
    await at(6);
    expect(posts).toHaveLength(1);
    causes = [];
    await at(0);
    await at(4);
    expect(posts).toHaveLength(1);
    await at(2);
    await at(1);
    expect(posts).toHaveLength(2);
    expect(posts[1]).toContain("Recovered");
  });

  test("causes someone else pages are never paged", async () => {
    causes = ["drill", "stuck:r1", "red:r1", "mirror", "snapshots", "budget:r1"];
    await at(0);
    await at(10);
    await at(10);
    expect(posts).toHaveLength(0);
    causes = [];
    await at(10);
    expect(posts).toHaveLength(0);
  });

  test("a restart with disk present pages nothing", async () => {
    causes = ["disk"];
    await notifier.close();
    await boot();
    await at(20);
    expect(posts).toHaveLength(0);
  });
});

describe("domain drill lines", () => {
  const URL_ = "https://forge.example.test";
  const DAY = 86_400_000;
  const t0 = Date.parse("2026-01-01T00:00:00Z");
  let dataDir: string;
  let app: App;
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-domain-drill-"));
    app = createApp({ dataDir, port: 0 });
    seedFirstSeen(dataDir, t0);
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });
  const person = async (name: string, adminIfFirst: boolean) => {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: name,
      email: `${name}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst,
    });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };

  test("an admin hears drill:never naming every command, once per need", async () => {
    const admin = await person("alice", true);
    const now = t0 + 9 * DAY;
    const lines = domainDrillLines(app, admin, now, URL_);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.id.startsWith("drill:never")).toBe(true);
    for (const d of DOMAINS)
      if (d.drill.name !== null) expect(lines[0]!.line).toContain(drillCommand(d.key, URL_));
    // A repeat tick carries the same id: nothing new to send.
    expect(domainDrillLines(app, admin, now + 60_000, URL_)[0]!.id).toBe(lines[0]!.id);
  });

  test("a later red is a new id", async () => {
    const admin = await person("alice", true);
    recordDrill(app.db, admin.id, "compute", { health: "", board: "" }, 1, { green: false, why: 'the forge never said "x"' });
    const first = domainDrillLines(app, admin, t0 + DAY, URL_).find((l) => l.id.startsWith("drill:compute"));
    expect(first).toBeDefined();
    app.db.query("UPDATE domain_drill SET at = '2099-01-01T00:00:00.000Z'").run();
    const next = domainDrillLines(app, admin, t0 + DAY, URL_).find((l) => l.id.startsWith("drill:compute"));
    expect(next!.id).not.toBe(first!.id);
  });

  test("through the notifier: one post, none on a repeat tick, one on a later red", async () => {
    const admin = await person("alice", true);
    setNotifyUrl(app.db, admin.id, "https://ntfy.example.test/root-topic");
    let clock = t0 + 7 * DAY;
    const posts: string[] = [];
    const notifier = startNotifier(app, {
      forgeUrl: URL_,
      now: () => clock,
      drainingSince: () => null,
      causes: () => [],
      send: async (_u, body) => {
        posts.push(body);
        return true;
      },
    });
    try {
      await notifier.settled();
      clock = t0 + 9 * DAY;
      app.bus.append({ kind: "drill.finished", payload: {} });
      await new Promise((r) => setTimeout(r, 20));
      await notifier.settled();
      const drills = () => posts.filter((p) => p.includes("scripts/drills/run.ts"));
      expect(drills()).toHaveLength(1);
      for (const d of DOMAINS)
        if (d.drill.name !== null) expect(drills()[0]).toContain(drillCommand(d.key, URL_));
      clock += MIN;
      app.bus.append({ kind: "drill.finished", payload: {} });
      await new Promise((r) => setTimeout(r, 20));
      await notifier.settled();
      expect(drills()).toHaveLength(1);
      recordDrill(app.db, admin.id, "compute", { health: "", board: "" }, 1, { green: false, why: 'the forge never said "x"' });
      clock += MIN;
      app.bus.append({ kind: "drill.finished", payload: {} });
      await new Promise((r) => setTimeout(r, 20));
      await notifier.settled();
      expect(drills()).toHaveLength(2);
      expect(drills()[1]).toContain(drillCommand("compute", URL_));
    } finally {
      await notifier.close();
    }
  });

  test("a non-admin hears nothing", async () => {
    await person("alice", true);
    const bob = await person("bob", false);
    expect(domainDrillLines(app, bob, t0 + 9 * DAY, URL_)).toEqual([]);
  });
});
