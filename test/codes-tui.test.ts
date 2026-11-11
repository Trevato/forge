/** Gift codes in the terminal (#11157): an admin makes, sees and revokes; no one else is offered it. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { codesScreen, entry } from "../src/tui/screens/codes.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dir: string;
let app: App;
let alice: User;
let bob: User;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-codes-tui-"));
  app = createApp({ dataDir: dir, port: 0, forgeRepo: "alice/forge-code" });
  const a = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  const b = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "b@forge.local", password: "a-good-passphrase" });
  if (!a.ok || !b.ok) throw new Error("user");
  alice = a.value;
  bob = b.value;
});
afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const key = (k: string) => ({ type: "key" as const, key: k, ctrl: false, alt: false, shift: false });
function open(user: User) {
  const { app: tui, session } = createForgeApp(
    app,
    { sshUsername: user.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user },
    { terminal: headlessTerminal(140, 40), exitHooks: false },
  );
  tui.start();
  return { tui, session };
}
const count = () => app.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM gift_code").get()!.n;

test("the entry is offered to an admin only", () => {
  expect(entry.offered(open(alice).session)).toBe(true);
  expect(entry.offered(open(bob).session)).toBe(false);
});

test("the admin makes a code, sees it once with its link, and revokes it after a yes", async () => {
  const { tui, session } = open(alice);
  tui.ctx.push(codesScreen(session, tui.ctx));
  await settleApp(tui);
  expect(tui.screen.toText()).toContain("No code yet.");
  tui.dispatch(key("n"));
  await settleApp(tui);
  expect(count()).toBe(1);
  expect(tui.screen.toText()).toMatch(/forge-[a-z0-9]{4}-[a-z0-9]{4}/);
  expect(tui.screen.toText()).toContain("0 of 1 used");
  tui.dispatch(key("x"));
  await settleApp(tui);
  expect(tui.screen.toText()).toContain("Made forges keep their plan");
  tui.dispatch(key("y"));
  await settleApp(tui);
  expect(tui.screen.toText()).toContain("revoked");
  expect(app.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM gift_code WHERE revoked_at IS NOT NULL").get()!.n).toBe(1);
  tui.stop?.();
});

test("a code made elsewhere shows up live", async () => {
  const { tui, session } = open(alice);
  tui.ctx.push(codesScreen(session, tui.ctx));
  await settleApp(tui);
  const { makeCode } = await import("../src/actions/codes.ts");
  expect(makeCode(app, alice, { plan: "large", note: "elsewhere" }, "http://x").ok).toBe(true);
  await new Promise((r) => setTimeout(r, 150));
  await settleApp(tui);
  expect(tui.screen.toText()).toContain("elsewhere");
  tui.stop?.();
});

test("a non-admin who reaches the screen makes nothing", async () => {
  const before = count();
  const { tui, session } = open(bob);
  tui.ctx.push(codesScreen(session, tui.ctx));
  await settleApp(tui);
  tui.dispatch(key("n"));
  await settleApp(tui);
  expect(count()).toBe(before);
  tui.stop?.();
});
