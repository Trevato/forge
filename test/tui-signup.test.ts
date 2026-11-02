/**
 * Who may sign up, in the terminal (#7292): the Invite links screen says it, `s`
 * picks a mode, shows from → to and changes it only after a confirm; esc
 * changes nothing; a non-admin and an agent are never offered it.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App as Forge } from "../src/app.ts";
import { signupClosed } from "../src/actions/users.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { readSignup } from "../src/actions/signup.ts";
import { Session } from "../src/tui/session.ts";
import { invitesScreen } from "../src/tui/screens/invites.ts";
import { getSignup, setSignup } from "../src/settings/signup.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dir: string;
let forge: Forge;

function boot(username: string) {
  const user = getUserByName(forge.db, username)!;
  const identity: TuiIdentity = { sshUsername: "t", remoteAddress: "127.0.0.1", user };
  const { app } = createForgeApp(forge, identity, { terminal: headlessTerminal(140, 32), exitHooks: false });
  app.start();
  const k = (key: string, ctrl = false) => app.dispatch({ type: "key", key, ctrl, alt: false, shift: false });
  return {
    text: () => app.screen.toText(),
    press: async (...keys: string[]) => {
      keys.forEach((x) => k(x));
      await settleApp(app);
    },
    open: async () => {
      k("k", true);
      for (const ch of "Invite links") k(ch);
      k("enter");
      await settleApp(app);
    },
    stop: () => app.stop(),
  };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-signup-"));
  forge = createApp({ dataDir: dir, port: 0 });
  for (const [username, adminIfFirst] of [["alice", true], ["bob", false], ["carol", false]] as const) {
    const made = await createUser(forge.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst,
    });
    if (!made.ok) throw new Error(made.error);
  }
  forge.db.query("UPDATE user SET is_admin = 1, is_agent = 1 WHERE username = 'carol'").run();
  setSignup(forge.db, "open", getUserByName(forge.db, "alice")!.id);
});
afterAll(async () => {
  forge.close();
  await rm(dir, { recursive: true, force: true });
});

test("reads open, esc changes nothing, a confirm closes the door", async () => {
  const h = boot("alice");
  await h.open();
  expect(h.text()).toContain("signup: open");
  // picker, closed, then esc on the plan
  await h.press("s", "j", "j", "enter");
  expect(h.text()).toContain("from open to closed");
  await h.press("esc");
  expect(getSignup(forge.db)).toBe("open");
  // esc on the picker too
  await h.press("s", "esc");
  expect(getSignup(forge.db)).toBe("open");
  await h.press("s", "j", "j", "enter", "enter");
  expect(getSignup(forge.db)).toBe("closed");
  expect(signupClosed({ db: forge.db } as never)).toBe(true);
  expect(h.text()).toContain("signup: closed");
  // what MCP `signup` and the admin settings read sees it, with the change kept
  // (setSignup emits no event; it writes forge_setting_change)
  const alice = getUserByName(forge.db, "alice")!;
  const seen = readSignup(forge as never, alice);
  expect(seen.ok && seen.value.signup).toBe("closed");
  expect(seen.ok && seen.value.changes[0]).toMatchObject({ from: "open", to: "closed" });
  h.stop();
  setSignup(forge.db, "open", getUserByName(forge.db, "alice")!.id);
});

test("a non-admin and an admin agent are never offered s", async () => {
  for (const who of ["bob", "carol"]) {
    const h = boot(who);
    await h.open();
    expect(h.text()).not.toContain("signup:");
    await h.press("s", "j", "j", "enter", "enter");
    expect(getSignup(forge.db)).toBe("open");
    h.stop();
    const user = getUserByName(forge.db, who)!;
    const session = new Session(forge, { sshUsername: "t", remoteAddress: "127.0.0.1", user });
    const screen = invitesScreen(session, { push() {}, invalidate() {} } as never);
    expect(screen.keys.flatMap((b) => b.keys ?? [])).not.toContain("s");
  }
  const admin = new Session(forge, { sshUsername: "t", remoteAddress: "127.0.0.1", user: getUserByName(forge.db, "alice")! });
  const own = invitesScreen(admin, { push() {}, invalidate() {} } as never);
  expect(JSON.stringify(own.keys)).toContain('"s"');
});
