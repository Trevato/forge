/**
 * A roll the image's launcher undid pages the admins once (#2652). It
 * happened before the forge that serves began, so the boot baseline would
 * swallow it; the record on disk says whether it was told, and a second
 * boot does not tell it again.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { setNotifyUrl, startNotifier } from "../src/crew/notify.ts";
import { vitals } from "../src/kernel/vitals.ts";
import { rolledBack } from "../src/release/launch.ts";

let dataDir: string;
let app: App;
const posts: string[] = [];
let deliver = true;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-notify-rollback-"));
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
  deliver = true;
});
afterEach(async () => {
  app.db.close();
  await rm(dataDir, { recursive: true, force: true });
});

const record = (said?: string) => {
  mkdirSync(join(dataDir, "release"), { recursive: true });
  writeFileSync(
    join(dataDir, "release", "rolled-back.json"),
    JSON.stringify({ from: "0.7.166", to: "0.7.162", at: "2026-10-19T05:17:00.000Z", why: "it exited with 1 before it was ready", said, paged: false }),
  );
};

async function boot(): Promise<void> {
  const notifier = startNotifier(app, {
    forgeUrl: "https://forge.example.test",
    drainingSince: () => null,
    causes: () => [],
    send: async (_u, body) => {
      if (deliver) posts.push(body);
      return deliver;
    },
  });
  await notifier.settled();
  await notifier.tick();
  await notifier.close();
}

const SENTENCE = "Release 0.7.166 did not become ready (it exited with 1 before it was ready); rolled back to 0.7.162.";

test("a rollback is a card linking the board, and pages once across boots", async () => {
  record();
  expect(vitals({ db: app.db, signals: app.signals, dataDir }).degraded.find((d) => d.cause === "release:rolled-back")).toMatchObject({
    sentence: SENTENCE,
    href: "/board",
    since: "2026-10-19T05:17:00.000Z",
  });
  await boot();
  expect(posts).toEqual([`${SENTENCE}\nhttps://forge.example.test/`]);
  expect(rolledBack(dataDir)?.paged).toBe(true);
  await boot();
  expect(posts).toHaveLength(1);
});

test("a page that was not delivered is not marked, and goes out on a later try", async () => {
  record();
  deliver = false;
  await boot();
  expect(rolledBack(dataDir)?.paged).toBe(false);
  deliver = true;
  await boot();
  expect(posts).toHaveLength(1);
  expect(rolledBack(dataDir)?.paged).toBe(true);
});

test("no record, no page", async () => {
  await boot();
  expect(posts).toEqual([]);
});

test("the release's last words reach the card and the page, with anything credential-shaped masked", async () => {
  record("error: GET https://x.test failed with Bearer abcdefghijklmnopqrstuvwxyz0123");
  const said = `${SENTENCE} It said: error: GET https://x.test failed with [redacted]`;
  expect(vitals({ db: app.db, signals: app.signals, dataDir }).degraded.find((d) => d.cause === "release:rolled-back")?.sentence).toBe(said);
  await boot();
  expect(posts).toEqual([`${said}\nhttps://forge.example.test/`]);
});
