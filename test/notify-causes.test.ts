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
import { createUser } from "../src/core/users.ts";
import { owned } from "../src/crew/incidents.ts";
import { setNotifyUrl, startNotifier, type Notifier } from "../src/crew/notify.ts";

const MIN = 60_000;

describe("owned causes", () => {
  test("an explicit list", () => {
    for (const c of ["errors", "internal", "disk", "release", "queue:check", "queue:run"])
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
