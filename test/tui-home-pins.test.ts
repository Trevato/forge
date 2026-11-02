/**
 * Home's pinned panels in the terminal (#8726): a forge admin who is a person
 * lists their own pins in home's order, moves and unpins them, and each change
 * is an event for them alone, which home's live region redraws on. Nobody
 * else has the door, and nobody else's pins show.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PINS_EVENT, pinPanel } from "../src/actions/board-pins.ts";
import { writeBoard } from "../src/actions/boards.ts";
import { createAgent } from "../src/actions/crew.ts";
import { createApp, type App } from "../src/app.ts";
import { listPins } from "../src/boards/pins.ts";
import { eventAudience } from "../src/core/event_audience.ts";
import type { ForgeEvent } from "../src/core/events.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp, forgeCommands } from "../src/tui/forge.ts";
import { homePinsScreen } from "../src/tui/screens/home_pins.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dir: string;
let app: App;
let carol: User;
let dana: User;
let bob: User;
let bot: User;

const identity = (user?: User) => ({ sshUsername: user?.username ?? "git", remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user });

async function screenText(user: User | undefined, keys = ""): Promise<string> {
  const terminal = headlessTerminal(120, 30);
  const { app: tui, session } = createForgeApp(app, identity(user), { terminal, exitHooks: false });
  tui.start();
  tui.ctx.push(homePinsScreen(session, tui.ctx));
  await settleApp(tui);
  for (const key of keys) {
    terminal.feed(key);
    await settleApp(tui);
  }
  const text = tui.screen.toText();
  tui.stop?.();
  return text;
}

const doors = (user?: User): string[] => {
  const { app: tui, session } = createForgeApp(app, identity(user), { terminal: headlessTerminal(80, 24), exitHooks: false });
  const ids = forgeCommands(session)(tui.ctx).map((c) => c.id);
  tui.stop?.();
  return ids;
};

const order = (u: User) => listPins(app.db, u.id).map((p) => p.title);
const panel = (title: string) => ({ title, chart: "number", query: { source: "runs", aggregate: "count" }, w: 1, h: 1 });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-home-pins-"));
  app = createApp({ dataDir: dir, port: 0 });
  const mk = async (username: string, first = false) => {
    const r = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst: first });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  carol = await mk("carol", true);
  dana = await mk("dana");
  app.db.run("UPDATE user SET is_admin = 1 WHERE id = ?", [dana.id]);
  dana = { ...dana, isAdmin: true };
  bob = await mk("bob");
  const made = await createAgent(app, carol, { username: "pinbot", brief: "x" });
  if (!made.ok) throw new Error(String(made.error));
  app.db.run("UPDATE user SET is_admin = 1 WHERE id = ?", [made.value.user.id]);
  bot = { ...made.value.user, isAdmin: true };
  const w = await writeBoard(app, carol, "mine", { title: "Mine", range: "all", refresh: "off", panels: [panel("Pin A"), panel("Pin B"), panel("Pin C")] });
  if (!w.ok) throw new Error(JSON.stringify(w.error));
  for (const t of ["Pin A", "Pin B", "Pin C"]) expect((await pinPanel(app, carol, "mine", t)).ok).toBe(true);
  expect((await pinPanel(app, dana, "mine", "Pin C")).ok).toBe(true);
}, 30_000);

afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("tui home pins", () => {
  test("the palette offers the door to an admin person only", () => {
    expect(doors(carol)).toContain("home-pins");
    expect(doors(bob)).not.toContain("home-pins");
    expect(doors(bot)).not.toContain("home-pins");
    expect(doors(undefined)).not.toContain("home-pins");
  });

  test("an admin person reads their own pins in home's order, nobody else's", async () => {
    const text = await screenText(carol);
    expect(text).toContain("3 panels pinned to home");
    expect(text.indexOf("Pin A")).toBeLessThan(text.indexOf("Pin B"));
    expect(text.indexOf("Pin B")).toBeLessThan(text.indexOf("Pin C"));
    const hers = await screenText(dana);
    expect(hers).toContain("1 panel pinned to home");
    expect(hers).not.toContain("Pin A");
  });

  test("a member and an agent see no pins and change none", async () => {
    for (const who of [bob, bot]) {
      const text = await screenText(who, "u>");
      expect(text).toContain("Nothing pinned");
    }
    expect(order(carol)).toEqual(["Pin A", "Pin B", "Pin C"]);
  });

  test("> moves the marked pin, u unpins it, and each change is an event for its owner alone", async () => {
    const seen: ForgeEvent[] = [];
    const off = app.bus.subscribe((e) => void (e.kind === PINS_EVENT && seen.push(e)));
    await screenText(carol, ">");
    expect(order(carol)).toEqual(["Pin B", "Pin A", "Pin C"]);
    await screenText(carol, "ju"); // the second row, now Pin A
    expect(order(carol)).toEqual(["Pin B", "Pin C"]);
    expect(order(dana)).toEqual(["Pin C"]);
    off();
    expect(seen.length).toBe(2);
    expect(seen.every((e) => e.actorId === carol.id)).toBe(true);
    expect(eventAudience(PINS_EVENT)).toBe("actor");
  });
});
