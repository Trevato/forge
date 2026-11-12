/**
 * The knobs in the terminal (#10461): a forge admin turns one with `e`
 * through `setKnob`; a value out of range is refused and changes nothing; a
 * member is shown nothing to turn.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { capacityValue } from "../src/core/capacity.ts";
import { listEvents } from "../src/core/events.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { knobsScreen } from "../src/tui/screens/knobs.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dir: string;
let app: App;
let carol: User;
let bob: User;

const identity = (user: User) => ({ sshUsername: user.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user });

async function boot(user: User) {
  const { app: tui, session } = createForgeApp(app, identity(user), { terminal: headlessTerminal(140, 40), exitHooks: false });
  tui.start();
  tui.ctx.push(knobsScreen(session, tui.ctx));
  await settleApp(tui);
  const press = async (...keys: string[]) => {
    for (const key of keys) tui.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
    await settleApp(tui);
  };
  return { press, text: () => tui.screen.toText(), stop: () => tui.stop?.() };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-knobs-"));
  app = createApp({ dataDir: dir, port: 0 });
  const mk = async (username: string, first = false) => {
    const r = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst: first });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  carol = await mk("carol", true);
  bob = await mk("bob");
}, 30_000);
afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("an admin turns Speed with e, and the capacity event is left", async () => {
  const h = await boot(carol);
  expect(h.text()).toContain("Speed");
  await h.press("e");
  for (let i = 0; i < 4; i++) await h.press("backspace");
  await h.press("3", "enter");
  expect(capacityValue(app.db, "crew.concurrency")).toBe("3");
  expect(h.text()).toContain("Speed: 3");
  expect(listEvents(app.db, {}).some((e) => e.kind === "capacity.changed")).toBe(true);
  h.stop();
});

test("e on Reserve says which dial it follows and changes nothing", async () => {
  const h = await boot(carol);
  await h.press("down", "down", "down", "down", "e");
  expect(h.text()).toContain("Reserve follows Weekly budget.");
  h.stop();
});

test("a value out of range changes nothing", async () => {
  const h = await boot(carol);
  await h.press("e");
  for (let i = 0; i < 4; i++) await h.press("backspace");
  await h.press("9", "9", "enter");
  expect(capacityValue(app.db, "crew.concurrency")).toBe("3");
  h.stop();
});

test("a member sees no knobs and e turns nothing", async () => {
  const h = await boot(bob);
  expect(h.text()).toContain("a forge admin's");
  await h.press("e", "9", "enter");
  expect(capacityValue(app.db, "crew.concurrency")).toBe("3");
  h.stop();
});
