/**
 * Devices in the terminal: only an admin is offered the screen; declaring and
 * removing there go through the page's actions and append the same events.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { declareDevice, listDevices } from "../src/core/devices.ts";
import { grantedSlugs } from "../src/core/device_grants.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp, forgeCommands, Session } from "../src/tui/forge.ts";
import { devicesScreen } from "../src/tui/screens/devices.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();
setDefaultTimeout(30_000);

let dir: string;
let app: App;
let admin: User;
let taker: User;
const kinds: string[] = [];
const identity = (user?: User) => ({ sshUsername: user?.username ?? "git", remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-devices-"));
  app = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
  const mk = async (username: string, adminIfFirst = false) => {
    const made = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@x.test`, password: "a-good-passphrase", adminIfFirst });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };
  admin = await mk("giver", true);
  taker = await mk("taker");
  app.bus.subscribe((e) => void kinds.push(e.kind));
});
afterAll(async () => {
  app.db.close();
  await rm(dir, { recursive: true, force: true });
});

async function withScreen(user: User, body: (h: { text: () => string; feed: (s: string) => Promise<void> }) => Promise<void>) {
  const terminal = headlessTerminal(120, 30);
  const { app: tui, session } = createForgeApp(app, identity(user), { terminal, exitHooks: false });
  tui.start();
  tui.ctx.push(devicesScreen(session, tui.ctx));
  try {
    await settleApp(tui);
    await body({
      text: () => tui.screen.toText(),
      feed: async (s) => {
        terminal.feed(s);
        await settleApp(tui);
      },
    });
  } finally {
    tui.stop();
  }
}

describe("the devices screen", () => {
  test("only an admin is offered it", () => {
    const ids = (u?: User) => forgeCommands(new Session(app, identity(u)))({} as never).map((c) => c.id);
    expect(ids(admin)).toContain("devices");
    expect(ids(taker)).not.toContain("devices");
    expect(ids({ ...admin, kind: "agent" })).not.toContain("devices");
    expect(ids()).not.toContain("devices");
  });

  test("a non-admin who reaches it sees the refusal and declares nothing", () =>
    withScreen(taker, async ({ text, feed }) => {
      expect(text()).toContain("Only a site admin manages devices.");
      await feed("d");
      await feed("Hall ipp://192.168.1.161/ipp/print\r");
      expect(listDevices(app.db)).toEqual([]);
    }));

  test("d declares with the page's refusals and events; x asks first then removes", () =>
    withScreen(admin, async ({ text, feed }) => {
      await feed("d");
      await feed("Cloud ipp://8.8.8.8/ipp/print\r");
      expect(text()).toContain("The address must be a number on your own network");
      expect(listDevices(app.db)).toEqual([]);
      for (let i = 0; i < "Cloud ipp://8.8.8.8/ipp/print".length; i++) await feed("\x7f");
      await feed("Hall printer ipp://192.168.1.161/ipp/print\r");
      expect(listDevices(app.db).map((d) => d.name)).toEqual(["Hall printer"]);
      expect(kinds.includes("device.declared")).toBe(true);
      await feed("x");
      await feed("\x1b"); // esc keeps it
      await Bun.sleep(100);
      expect(listDevices(app.db).length).toBe(1);
      await feed("x");
      await feed("\x1b[C\r");
      expect(listDevices(app.db)).toEqual([]);
      expect(kinds.includes("device.removed")).toBe(true);
    }));

  test("a allows the device under the cursor to an app and r revokes it, with the page's events", () =>
    (async () => {
      const d = declareDevice(app.db, { name: "Den", kind: "printer", url: "ipp://192.168.1.162/ipp/print" });
      if (!d.ok) throw new Error(d.error);
      app.db.run("PRAGMA foreign_keys = OFF");
      app.db.run("INSERT INTO app (id, repo_id, slug, access) VALUES ('t1', 'repo-t1', 'labels', 'private')");
      app.db.run("PRAGMA foreign_keys = ON");
      await withScreen(admin, async ({ text, feed }) => {
      const mine = () => grantedSlugs(app.db, d.value.id);
      await feed("a");
      await feed("nope\r");
      expect(text()).toContain("No such app");
      expect(mine()).toEqual([]);
      for (let n = 0; n < 4; n++) await feed("\x7f");
      await feed("labels\r");
      expect(mine()).toEqual(["labels"]);
      expect(kinds.includes("device.granted")).toBe(true);
      expect(text()).toContain("apps: labels 0/10 today");
      // l sets the daily limit through the page's action and event; a bad number changes nothing.
      const cap = () => app.db.query<{ daily_cap: number }, []>("SELECT daily_cap FROM device_grant WHERE app_id = 't1'").get()!.daily_cap;
      await feed("l");
      await feed("labels many\r");
      expect(cap()).toBe(10);
      expect(text()).toContain("A daily limit is a whole number");
      for (let n = 0; n < "labels many".length; n++) await feed("\x7f");
      await feed("labels 3\r");
      expect(cap()).toBe(3);
      expect(kinds.includes("device.cap_set")).toBe(true);
      expect(text()).toContain("labels 0/3 today");
      await feed("r");
      await feed("labels\r");
      expect(mine()).toEqual([]);
      expect(kinds.includes("device.revoked")).toBe(true);
      });
    })());
});
