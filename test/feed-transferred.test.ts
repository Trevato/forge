/** A moved repository is one line in its readers' feed, and not in a stranger's (#10100). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { transferRepository } from "../src/actions/transfer.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser, type User } from "../src/core/users.ts";
import { readFeed } from "../src/feed/feed.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let root = "";
let app: App;
let alice: User;
let bob: User;
let carol: User;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-feed-moved-"));
  app = createApp({ dataDir: root, port: 0 });
  const make = async (username: string, admin: boolean): Promise<User> => {
    const u = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: admin,
    });
    if (!u.ok) throw new Error(u.error);
    return u.value;
  };
  alice = await make("alice", true);
  bob = await make("bob", false);
  carol = await make("carol", false);
});
afterAll(() => {
  app.close();
  rmSync(root, { recursive: true, force: true });
});

test("the move reads as one line for the new owner, and a stranger never sees it", async () => {
  const made = await createRepo(app, alice, { name: "demo", visibility: "private" });
  if (!made.ok) throw new Error(String(made.error));
  const moved = await transferRepository(app, alice, made.value, "bob");
  if (!moved.ok) throw new Error(String(moved.error));
  const lines = (u: User) =>
    readFeed(app.db, u, { limit: 50 }).items.filter((i) => i.what.includes("moved from"));
  const mine = lines(bob);
  expect(mine).toHaveLength(1);
  expect(mine[0]!.what).toBe("moved from alice/demo to bob/demo");
  expect(mine[0]!.link).toBe("/bob/demo");
  expect(lines(carol)).toHaveLength(0);
});
