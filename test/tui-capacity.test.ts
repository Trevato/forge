/**
 * The forge's capacity in the terminal (#7275): a forge admin who is a person
 * lists the guards, changes a settable one after a plan and a confirm, and is
 * refused out of bounds; an agent or a member is offered nothing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent } from "../src/actions/crew.ts";
import { createApp, type App } from "../src/app.ts";
import { listEvents } from "../src/core/events.ts";
import { changeCapacity } from "../src/actions/capacity.ts";
import { CAPACITY_KEYS, capacityDefault, capacityValue } from "../src/core/capacity.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp, forgeCommands } from "../src/tui/forge.ts";
import { capacityScreen } from "../src/tui/screens/capacity.ts";
import { handover } from "../src/release/swap.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dir: string;
let app: App;
let carol: User;
let bob: User;
let bot: User;

const identity = (user?: User) => ({ sshUsername: user?.username ?? "git", remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user });
const crew = () => capacityValue(app.db, "crew.concurrency");

function boot(user: User) {
  const { app: tui, session } = createForgeApp(app, identity(user), { terminal: headlessTerminal(140, 40), exitHooks: false });
  tui.start();
  tui.ctx.push(capacityScreen(session, tui.ctx));
  const press = async (...keys: string[]) => {
    for (const key of keys) tui.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
    await settleApp(tui);
  };
  return { press, text: () => tui.screen.toText(), stop: () => tui.stop?.() };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-capacity-"));
  app = createApp({ dataDir: dir, port: 0 });
  const mk = async (username: string, first = false) => {
    const r = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst: first });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  carol = await mk("carol", true);
  bob = await mk("bob");
  const made = await createAgent(app, carol, { username: "capbot", brief: "x" });
  if (!made.ok) throw new Error(String(made.error));
  app.db.query("UPDATE user SET is_admin = 1 WHERE id = ?1").run(made.value.user.id);
  bot = { ...made.value.user, isAdmin: true };
}, 30_000);

afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("tui capacity", () => {
  test("only an admin who is a person is offered the door", () => {
    const door = (u: User) => {
      const { app: tui, session } = createForgeApp(app, identity(u), { terminal: headlessTerminal(80, 24), exitHooks: false });
      const ids = forgeCommands(session)(tui.ctx).map((c) => c.id);
      tui.stop?.();
      return ids;
    };
    expect(door(carol)).toContain("capacity");
    expect(door(bob)).not.toContain("capacity");
    expect(door(bot)).not.toContain("capacity");
  });

  test("lists each guard with its value and bounds", async () => {
    const h = boot(carol);
    await h.press();
    expect(h.text()).toContain("Crew runs at once");
    expect(h.text()).toContain("takes 1–16");
    expect(h.text()).toContain("Merge queue candidates at once");
    expect(h.text()).not.toContain("read-only");
    h.stop();
  });

  test("a crew concurrency below its ceiling is marked, and not at it", async () => {
    const ceiling = capacityDefault("crew.concurrency");
    try {
      changeCapacity(app, carol, "crew.concurrency", "1");
      const low = boot(carol);
      await low.press();
      expect(low.text()).toContain(`below ceiling ${ceiling}`);
      low.stop();
      changeCapacity(app, carol, "crew.concurrency", ceiling);
      const level = boot(carol);
      await level.press();
      expect(level.text()).not.toContain("below ceiling");
      level.stop();
    } finally {
      changeCapacity(app, carol, "crew.concurrency", null);
    }
  });

  test("changes crew concurrency after the plan and a confirm", async () => {
    const h = boot(carol);
    await h.press("e");
    for (let i = 0; i < 4; i++) await h.press("backspace");
    await h.press("7", "enter");
    expect(h.text()).toContain("→ 7");
    expect(crew()).not.toBe("7");
    await h.press("enter");
    expect(crew()).not.toBe("7");
    await h.press("e");
    for (let i = 0; i < 4; i++) await h.press("backspace");
    await h.press("7", "enter");
    await h.press("left", "enter");
    expect(crew()).toBe("7");
    h.stop();
  });

  test("refuses out of bounds in the setting words, and esc changes nothing", async () => {
    const h = boot(carol);
    const before = crew();
    await h.press("e");
    for (let i = 0; i < 4; i++) await h.press("backspace");
    await h.press("9", "9", "enter");
    expect(h.text()).toContain("outside what this setting takes");
    expect(crew()).toBe(before);
    await h.press("esc");
    expect(crew()).toBe(before);
    h.stop();
  });

  test("queue.depth, which the page sets, changes after a confirm", async () => {
    const h = boot(carol);
    for (let i = 0; i < CAPACITY_KEYS.indexOf("queue.depth"); i++) await h.press("j");
    await h.press("e");
    for (let i = 0; i < 4; i++) await h.press("backspace");
    await h.press("4", "enter");
    await h.press("left", "enter");
    expect(capacityValue(app.db, "queue.depth")).toBe("4");
    h.stop();
  });

  test("a change leaves a capacity.changed event, and restoring the default with an empty value works", async () => {
    const seen = () => listEvents(app.db, {}).filter((e) => e.kind === "capacity.changed").length;
    const before = seen();
    const h = boot(carol);
    await h.press("e");
    for (let i = 0; i < 4; i++) await h.press("backspace");
    await h.press("5", "enter");
    await h.press("left", "enter");
    expect(crew()).toBe("5");
    expect(seen()).toBe(before + 1);
    await h.press("e");
    for (let i = 0; i < 4; i++) await h.press("backspace");
    await h.press("enter");
    expect(h.text()).toContain("→ ");
    await h.press("left", "enter");
    expect(crew()).not.toBe("5");
    expect(seen()).toBe(before + 2);
    h.stop();
  });

  test("a typed value is trimmed before the plan", async () => {
    const h = boot(carol);
    await h.press("e");
    for (let i = 0; i < 4; i++) await h.press("backspace");
    await h.press(" ", "3", " ", "enter");
    await h.press("left", "enter");
    expect(crew()).toBe("3");
    h.stop();
  });

  test("signin.edge off for an admin with no credential is refused as a lockout, not as out of range", async () => {
    const kept = app.db.query<{ password_hash: string }, [string]>("SELECT password_hash FROM user WHERE id = ?1").get(carol.id)!.password_hash;
    app.db.query("UPDATE user SET password_hash = '' WHERE id = ?1").run(carol.id);
    const h = boot(carol);
    const before = capacityValue(app.db, "signin.edge");
    for (let i = 0; i < CAPACITY_KEYS.indexOf("signin.edge"); i++) await h.press("j");
    await h.press("e");
    for (let i = 0; i < 4; i++) await h.press("backspace");
    await h.press("o", "f", "f", "enter");
    await h.press("left", "enter");
    expect(capacityValue(app.db, "signin.edge")).toBe(before);
    expect(h.text()).toContain("lock you out");
    expect(h.text()).not.toContain("outside what");
    app.db.query("UPDATE user SET password_hash = ?2 WHERE id = ?1").run(carol.id, kept);
    h.stop();
  });

  test("a member or an agent calling the screen directly sees no rows and changes nothing", async () => {
    for (const who of [bob, bot]) {
      const h = boot(who);
      await h.press("e");
      expect(h.text()).not.toContain("Crew runs at once");
      expect(changeCapacity(app, who, "crew.concurrency", "9")).toEqual({ ok: false, error: "not_found" });
      h.stop();
    }
  });

  test("shows whether the forge can swap itself, and why not (#8383)", async () => {
    try {
      handover.migrate = true;
      handover.ssh = false;
      let h = boot(carol);
      await h.press();
      // This app was built without selfSwap: FORGE_SELF_SWAP is off.
      expect(h.text()).toContain("Self-swap");
      expect(h.text()).toContain("blocked · FORGE_SELF_SWAP off · tcp_migrate_req 1");
      expect(h.text()).toContain("FORGE_SELF_SWAP is off");
      h.stop();
      handover.migrate = false;
      h = boot(carol);
      await h.press();
      expect(h.text()).toContain("tcp_migrate_req 0");
      expect(h.text()).toContain("net.ipv4.tcp_migrate_req=1");
      h.stop();
      handover.migrate = true;
      handover.ssh = true;
      h = boot(carol);
      await h.press();
      expect(h.text()).toContain("holds the SSH terminal");
      h.stop();
      for (const who of [bob, bot]) {
        const m = boot(who);
        await m.press();
        expect(m.text()).not.toContain("Self-swap");
        m.stop();
      }
    } finally {
      delete handover.migrate;
      delete handover.ssh;
    }
  });
});
