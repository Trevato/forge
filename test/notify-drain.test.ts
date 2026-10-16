/**
 * A drain past five minutes pages the admin once, its end says Recovered
 * once; a page the cap or the backoff held back is sent later; what the
 * guard already shows (`stuck`, `drill`) is not paged here.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { drainIncident, nextPage } from "../src/crew/incidents.ts";
import { health, startDraining } from "../src/http/health.ts";
import { setNotifyUrl, startNotifier, type Notifier } from "../src/crew/notify.ts";

const MIN = 60_000;

describe("incidents (pure)", () => {
  test("only a drain past five minutes is an incident, keyed by its start", () => {
    expect(drainIncident(null, 10 * MIN)).toBeUndefined();
    expect(drainIncident(0, 5 * MIN)).toBeUndefined();
    expect(drainIncident(0, 6 * MIN)?.key).toBe("drain:0");
  });
  test("a page, then nothing, then Recovered", () => {
    const inc = drainIncident(0, 6 * MIN);
    const page = nextPage(inc, undefined)!;
    expect(page.paged).toBe("drain:0");
    expect(nextPage(inc, page.paged)).toBeUndefined();
    expect(nextPage(undefined, page.paged)?.line).toContain("Recovered");
    expect(nextPage(undefined, undefined)).toBeUndefined();
  });
});

describe("the drain page", () => {
  let dataDir: string;
  let app: App;
  let notifier: Notifier;
  let clock = 1_000_000;
  let since: number | null = null;
  let accept = true;
  const posts: string[] = [];

  async function boot(): Promise<void> {
    notifier = startNotifier(app, {
      forgeUrl: "https://forge.example.test",
      now: () => clock,
      drainingSince: () => since,
      send: async (_u, body) => {
        posts.push(body);
        return accept;
      },
    });
    await notifier.settled();
  }

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-drain-"));
    app = createApp({ dataDir, port: 0 });
    const made = await createUser(app.db, {
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
    since = null;
    accept = true;
    await boot();
  });
  afterEach(async () => {
    await notifier.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("six minutes of draining sends one page, its end one Recovered", async () => {
    since = clock;
    clock += 4 * MIN;
    await notifier.tick();
    expect(posts).toHaveLength(0);
    clock += 2 * MIN;
    await notifier.tick();
    await notifier.tick();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("draining for 6 minutes");
    since = null;
    await notifier.tick();
    await notifier.tick();
    expect(posts).toHaveLength(2);
    expect(posts[1]).toContain("Recovered");
  });

  test("a page the endpoint refused is sent on a later tick, and Recovered is not lost", async () => {
    since = clock;
    clock += 6 * MIN;
    accept = false;
    await notifier.tick();
    expect(posts).toHaveLength(1);
    // Backed off: nothing is tried at once.
    await notifier.tick();
    expect(posts).toHaveLength(1);
    accept = true;
    clock += 2 * MIN;
    await notifier.tick();
    expect(posts).toHaveLength(2);
    since = null;
    await notifier.tick();
    expect(posts).toHaveLength(3);
    expect(posts[2]).toContain("Recovered");
  });

  test("a restart in a paged drain does not page again", async () => {
    since = clock;
    clock += 6 * MIN;
    await notifier.close();
    await boot();
    await notifier.tick();
    expect(posts).toHaveLength(0);
  });

  test("a drain started the way main.ts starts it, with the notifier stopped beside it, is still paged", async () => {
    const real = Date.now();
    clock = real;
    await notifier.close();
    notifier = startNotifier(app, {
      forgeUrl: "https://forge.example.test",
      now: () => clock,
      send: async (_u, body) => {
        posts.push(body);
        return true;
      },
    });
    await notifier.settled();
    startDraining(app.log, "SIGTERM");
    notifier.stop();
    try {
      clock = real + 6 * MIN;
      await notifier.tick();
      await notifier.tick();
      expect(posts).toHaveLength(1);
      expect(posts[0]).toContain("draining");
    } finally {
      health.draining = false;
      health.drainingSince = null;
    }
  });

  test("a swap: the old process pages after the new one booted, and its exit says Recovered once", async () => {
    // The new process booted first and sees no drain of its own.
    const next = startNotifier(app, {
      forgeUrl: "https://forge.example.test",
      now: () => clock,
      drainingSince: () => null,
      send: async (_u, body) => {
        posts.push(body);
        return true;
      },
    });
    await next.settled();
    since = clock;
    clock += 6 * MIN;
    await notifier.tick();
    await next.tick();
    expect(posts).toHaveLength(1);
    await notifier.close();
    expect(posts).toHaveLength(2);
    expect(posts[1]).toContain("Recovered");
    await next.tick();
    await next.close();
    expect(posts).toHaveLength(2);
  });

  test("a page held back by the hourly cap is sent once the window rolls over", async () => {
    // Five pages and five Recovered fill the ten an hour.
    for (let i = 0; i < 5; i++) {
      since = clock;
      clock += 6 * MIN;
      await notifier.tick();
      since = null;
      await notifier.tick();
    }
    expect(posts).toHaveLength(10);
    since = clock;
    clock += 6 * MIN;
    await notifier.tick();
    expect(posts).toHaveLength(10);
    clock += 61 * MIN;
    await notifier.tick();
    expect(posts).toHaveLength(11);
    expect(posts[10]).toContain("draining");
  });
});
