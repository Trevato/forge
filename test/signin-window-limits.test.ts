/** The sign-in windows hold at their defaults: twenty per account, sixty per source (#9432). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { admitSignin } from "../src/core/signin-window.ts";

let dataDir = "";
let app: App;
beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-window-"));
  app = createApp({ dataDir, port: 0 });
});
afterAll(async () => {
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("one account is refused after twenty attempts from one address; another address has its own window", () => {
  for (let i = 0; i < 20; i++) expect(admitSignin(app.db, "carol", "203.0.113.1").admitted).toBe(true);
  expect(admitSignin(app.db, "carol", "203.0.113.1").admitted).toBe(false);
  expect(admitSignin(app.db, "carol", "203.0.113.9").admitted).toBe(true);
});

test("one address is refused after sixty attempts across accounts", () => {
  for (let i = 0; i < 60; i++) expect(admitSignin(app.db, `user${i}`, "198.51.100.7").admitted).toBe(true);
  const shut = admitSignin(app.db, "user-new", "198.51.100.7");
  expect(shut.admitted).toBe(false);
  expect(!shut.admitted && shut.retryAfter).toBeGreaterThan(0);
});
