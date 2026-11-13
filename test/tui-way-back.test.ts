/**
 * Both doors for the way-back link (#11802): the terminal screen lists the
 * accounts the page offers a button for, Enter mints the link with the same
 * action and shows it once, and anyone but an admin is told it is not there.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { linkEdgeLogin } from "../src/core/edge_links.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { sha256 } from "../src/kernel/hash.ts";
import type { Ctx } from "../src/tui/app/app.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { wayBackScreen, entry } from "../src/tui/screens/wayback.ts";
import type { Session } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dir = "";
let app: App;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-way-back-"));
  app = createApp({ dataDir: dir, port: 0 });
  const a = await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  if (!a.ok) throw new Error(a.error);
  const b = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "bob@forge.local", password: "a-good-passphrase", adminIfFirst: false });
  if (!b.ok) throw new Error(b.error);
  const insert = (name: string) =>
    app.db
      .query("INSERT INTO user (id, username, kind, email, display_name, password_hash) VALUES (?1, ?1, 'user', ?1 || '@users.noreply.test', ?1, '')")
      .run(name);
  insert("stranded");
  linkEdgeLogin(app.db, getUserByName(app.db, "stranded")!, "stranded-login");
  insert("unmapped");
});
afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

function boot(username: string) {
  const user = getUserByName(app.db, username)!;
  const { app: tui } = createForgeApp(
    app,
    { sshUsername: "t", remoteAddress: "127.0.0.1", user },
    { terminal: headlessTerminal(140, 32), exitHooks: false },
  );
  tui.start();
  const key = async (k: string, ctrl = false) => {
    tui.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
    await settleApp(tui);
  };
  return { tui, key, text: () => tui.screen.toText() };
}

const handover = () =>
  app.db.query<{ token_hash: string; by_id: string }, [string]>("SELECT token_hash, by_id FROM edge_handover WHERE user_id = ?1").get("stranded");

test("an admin makes the way-back link in the terminal; it is the one the recover step spends", async () => {
  const t = boot("alice");
  await t.key("k", true);
  for (const ch of "Way-back links") await t.key(ch);
  await t.key("enter");
  expect(t.text()).toContain("stranded");
  expect(t.text()).toContain("edge login stranded-login");
  expect(t.text()).not.toContain("unmapped");
  expect(handover()).toBeNull();

  await t.key("enter");
  const shown = t.text();
  expect(shown).toContain("Hand this to stranded (edge login stranded-login)");
  expect(shown).toContain("not shown again");
  const token = /\/recover\?token=([A-Za-z0-9_-]+)/.exec(shown)?.[1];
  expect(token).toBeDefined();
  const row = handover()!;
  expect(row.token_hash).toBe(sha256(token!));
  expect(row.by_id).toBe(getUserByName(app.db, "alice")!.id);

  // Gone once the screen is: back on the list, the token is not on screen.
  await t.key("esc");
  expect(t.text()).toContain("edge login stranded-login");
  expect(t.text()).not.toContain(token!);
  t.tui.stop();
});

test("anyone but an admin is not offered it, and built directly it mints nothing", async () => {
  const before = handover();
  const bob = getUserByName(app.db, "bob")!;
  expect(entry.offered({ user: bob } as unknown as Session)).toBe(false);
  expect(entry.offered({ user: getUserByName(app.db, "alice")! } as unknown as Session)).toBe(true);

  const t = boot("bob");
  await t.key("k", true);
  for (const ch of "Way-back links") await t.key(ch);
  expect(t.text()).not.toContain("a link that signs in an account the edge made");
  t.tui.stop();

  const pushed: unknown[] = [];
  const screen = wayBackScreen(
    { db: app.db, app, user: bob } as unknown as Session,
    { push: (s: unknown) => pushed.push(s), invalidate() {} } as unknown as Ctx,
  );
  screen.key({ type: "key", key: "enter", ctrl: false, alt: false, shift: false });
  expect(pushed).toEqual([]);
  expect(handover()).toEqual(before);
});
