/**
 * #477 end to end: a degraded forge (a burst of errors) turns the board's forge strip from All fine to a need line,
 * pages the phone once after five minutes, nothing more while it
 * lasts, and once more (Recovered) after five minutes clear, when the strip
 * says all fine. The vitals and the board are the real ones; only the clock
 * the pager reads and the notify endpoint are fakes.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { setNotifyUrl, startNotifier, type Notifier } from "../src/crew/notify.ts";
import { ERROR_BURST } from "../src/kernel/vitals.ts";
import { serve, type Servers } from "../src/http/server.ts";

const MIN = 60_000;

let dataDir: string;
let app: App;
let servers: Servers;
let notifier: Notifier;
let cookie: string;
let clock = Date.now();
const posts: string[] = [];

const board = async (): Promise<string> =>
  (await fetch(`${servers.url}/board`, { headers: { cookie } })).text();
const at = async (min: number): Promise<void> => {
  clock += min * MIN;
  await notifier.tick();
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-degraded-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
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
  cookie = (
    (
      await fetch(`${servers.url}/signin`, {
        method: "POST",
        body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
        redirect: "manual",
      })
    ).headers.get("set-cookie") ?? ""
  ).split(";")[0]!;
  app.signals.errors.clear();
  app.signals.refused.clear();
  notifier = startNotifier(app, {
    forgeUrl: "https://forge.example.test",
    now: () => clock,
    drainingSince: () => null,
    send: async (_u, body) => {
      posts.push(body);
      return true;
    },
  });
  await notifier.settled();
}, 30_000);

afterAll(async () => {
  await notifier.close();
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("a burst of errors: the board says so, one page, no more; clear for five minutes: one Recovered, all fine", async () => {
  expect(await board()).toContain("All fine");

  for (let i = 0; i < ERROR_BURST; i++) app.signals.errors.record("test", "boom", clock);
  await at(0);
  const burst = await board();
  expect(burst).toMatch(/data-ok="no"/);
  expect(burst).toMatch(/data-need href="\/settings\/capacity#errors">[\s\S]*?20 errors in the last hour/);
  expect(burst).not.toContain("All fine");
  await at(4);
  expect(posts).toHaveLength(0);

  await at(2);
  expect(posts).toHaveLength(1);
  expect(posts[0]).toContain("errors in the last hour");
  expect(await board()).toMatch(/data-ok="no"/);

  await at(1);
  await at(10);
  await at(30);
  expect(posts).toHaveLength(1);

  app.signals.errors.clear();
  await at(0);
  await at(4);
  expect(posts).toHaveLength(1);
  await at(2);
  await at(1);
  await at(10);
  expect(posts).toHaveLength(2);
  expect(posts[1]).toContain("Recovered");
  const calm = await board();
  expect(calm).toContain("All fine");
  expect(calm).toMatch(/data-ok="yes"/);
  expect(calm).not.toContain("data-need");
});
