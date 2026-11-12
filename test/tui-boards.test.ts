/**
 * /boards in the terminal (#1817): the screen reads the page's own action, so
 * a forge admin who is a person lists boards and reads their panels as text,
 * and an agent, a member or a guest has neither the door nor the rows.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listPinned, pinPanel, unpinPanel } from "../src/actions/board-pins.ts";
import { deleteBoard, listAllBoards, writeBoard } from "../src/actions/boards.ts";
import { createAgent } from "../src/actions/crew.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp, forgeCommands, Session } from "../src/tui/forge.ts";
import { dashboardScreen } from "../src/tui/screens/dashboard.ts";
import { boardRows, boardsScreen, dataLine, refusal, stepWords } from "../src/tui/screens/boards.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dir: string;
let app: App;
let carol: User;
let bob: User;
let bot: User;

const identity = (user?: User) => ({
  sshUsername: user?.username ?? "git",
  remoteAddress: "127.0.0.1",
  fingerprint: "SHA256:test",
  user,
});

async function screenText(user?: User, keys = ""): Promise<string> {
  const terminal = headlessTerminal(120, 30);
  const { app: tui, session } = createForgeApp(app, identity(user), { terminal, exitHooks: false });
  tui.start();
  tui.ctx.push(boardsScreen(session, tui.ctx));
  await settleApp(tui);
  // One key at a time: a key that opens a screen must land before the next is read.
  for (const key of keys) {
    terminal.feed(key);
    await settleApp(tui);
  }
  const text = tui.screen.toText();
  tui.stop?.();
  return text;
}

const doors = (user?: User): string[] => {
  const { app: tui, session } = createForgeApp(app, identity(user), {
    terminal: headlessTerminal(80, 24),
    exitHooks: false,
  });
  const ids = forgeCommands(session)(tui.ctx).map((c) => c.id);
  tui.stop?.();
  return ids;
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-boards-"));
  app = createApp({ dataDir: dir, port: 0 });
  const mk = async (username: string, first = false) => {
    const r = await createUser(app.db, {
      origin: "seed",
      trusted: true, username, email: `${username}@forge.local`,
      password: "a-good-passphrase", adminIfFirst: first,
    });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  carol = await mk("carol", true);
  bob = await mk("bob");
  const made = await createAgent(app, carol, { username: "boardbot", brief: "x" });
  if (!made.ok) throw new Error(String(made.error));
  app.db.query("UPDATE user SET is_admin = 1 WHERE id = ?1").run(made.value.user.id);
  bot = { ...made.value.user, isAdmin: true };
  const wrote = await writeBoard(app, carol, "runs", {
    title: "Runs this week",
    range: "7d",
    refresh: "off",
    panels: [{ title: "Failed runs", chart: "number", query: { source: "runs", aggregate: "count" }, w: 1, h: 1 }],
  });
  if (!wrote.ok) throw new Error(JSON.stringify(wrote.error));
}, 30_000);

afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("tui boards", () => {
  test("an admin person sees the boards and reads a board's panels", async () => {
    expect(await screenText(carol)).toContain("Runs this week");
    const text = await screenText(carol, "\r");
    expect(text).toContain("Failed runs");
    expect(text).toContain("number");
    expect(text).toContain("source=runs");
  });

  test("each panel says what panelData reads for it: a time panel its last bucket and step, another its rows", async () => {
    const wrote = await writeBoard(app, carol, "weekly", {
      title: "Hourly runs",
      range: "7d",
      refresh: "off",
      panels: [
        { title: "Runs per hour", chart: "line", query: { source: "runs", aggregate: "count", groupBy: { bucket: "hour" } }, w: 1, h: 1 },
        { title: "Runs by state", chart: "bar", query: { source: "runs", aggregate: "count", groupBy: "state" }, w: 1, h: 1 },
      ],
    });
    if (!wrote.ok) throw new Error(JSON.stringify(wrote.error));
    // The boards are listed by slug: runs, then weekly.
    const text = await screenText(carol, "j\r");
    expect(text).toContain("no points · step 1h · 0 points");
    expect(text).toContain("0 rows");
    expect(dataLine({ ok: true, rows: [{ group: "2026-10-20T21:45:00Z", value: 1500 }], from: null, to: null, step: 300 }))
      .toBe("last 2026-10-20T21:45:00Z: 1500 · step 5m · 1 point");
    expect(dataLine({ ok: false, error: "too\u001b[2Jmany" })).toBe("refused: too [2Jmany");
    expect([15, 300, 3600, 86_400, 90].map(stepWords)).toEqual(["15s", "5m", "1h", "1d", "90s"]);
    await deleteBoard(app, carol, "weekly");
  });

  test("nobody else has rows or the door", async () => {
    for (const who of [bob, bot, undefined]) {
      expect(await boardRows(new Session(app, identity(who)))).toEqual([]);
      expect(doors(who)).not.toContain("boards");
      expect(await screenText(who)).not.toContain("Runs this week");
    }
    expect(doors(carol)).toContain("boards");
  });

  test("p pins the marked panel, the dashboard lists it by title, p again unpins", async () => {
    const pinned = async () => {
      const listed = await listPinned(app, carol);
      return listed.ok ? listed.value.map((p) => p.title) : [];
    };
    expect(await pinned()).toEqual([]);
    const text = await screenText(carol, "\rp");
    expect(text).toContain("[pinned to home]");
    expect(await pinned()).toEqual(["Failed runs"]);

    const terminal = headlessTerminal(120, 30);
    const { app: tui, session } = createForgeApp(app, identity(carol), { terminal, exitHooks: false });
    tui.start();
    tui.ctx.push(dashboardScreen(session, tui.ctx));
    await settleApp(tui);
    expect(tui.screen.toText()).toContain("Pinned: Failed runs (Runs this week)");
    tui.stop?.();

    await screenText(carol, "\rp");
    expect(await pinned()).toEqual([]);
    // Nobody else can pin from the terminal.
    await screenText(bob, "\rp");
    const other = await listPinned(app, bob);
    expect(other.ok).toBe(false);
  });

  test("> and < move the marked pinned panel in the home order; an unpinned one does not move", async () => {
    const wrote = await writeBoard(app, carol, "runs", {
      title: "Runs this week",
      range: "7d",
      refresh: "off",
      panels: [
        { title: "Failed runs", chart: "number", query: { source: "runs", aggregate: "count" }, w: 1, h: 1 },
        { title: "Slow runs", chart: "number", query: { source: "runs", aggregate: "count" }, w: 1, h: 1 },
      ],
    });
    expect(wrote.ok).toBe(true);
    const order = async () => {
      const listed = await listPinned(app, carol);
      return listed.ok ? listed.value.map((p) => p.title) : [];
    };
    expect(await order()).toEqual([]);
    // Not pinned: nothing moves and nothing is claimed.
    expect(await screenText(carol, "\r>")).not.toContain("moved on home");
    await pinPanel(app, carol, "runs", "Failed runs");
    await pinPanel(app, carol, "runs", "Slow runs");
    expect(await order()).toEqual(["Failed runs", "Slow runs"]);
    await screenText(carol, "\r>");
    expect(await order()).toEqual(["Slow runs", "Failed runs"]);
    await screenText(carol, "\r<");
    expect(await order()).toEqual(["Failed runs", "Slow runs"]);
    // At the top already: it stays.
    await screenText(carol, "\r<");
    expect(await order()).toEqual(["Failed runs", "Slow runs"]);
    unpinPanel(app, carol, "runs", "Failed runs");
    unpinPanel(app, carol, "runs", "Slow runs");
  });

  const slugs = async (): Promise<string[]> => {
    const listed = await listAllBoards(app, carol);
    return listed.ok ? listed.value.map((b) => b.slug) : [];
  };

  test("n makes a board from a title and opens it; c copies the marked board; D asks y/n and deletes", async () => {
    expect(await slugs()).toEqual(["runs"]);
    const made = await screenText(carol, "nFresh start\r");
    expect(await slugs()).toEqual(["fresh-start", "runs"]);
    expect(made).toContain("Fresh start");
    expect(made).toContain("0 panels");

    // The list is by slug: fresh-start, runs. Copy the second.
    const copied = await screenText(carol, "jc");
    expect(await slugs()).toEqual(["fresh-start", "runs", "runs-copy"]);
    expect(copied).toContain("Runs this week (copy)");

    // n answers nothing: the board stays.
    expect(await screenText(carol, "Dn")).not.toContain("y/n");
    expect(await slugs()).toContain("fresh-start");
    expect(await screenText(carol, "D")).toContain("delete Fresh start? y/n");
    await screenText(carol, "Dy");
    expect(await slugs()).toEqual(["runs", "runs-copy"]);
    await deleteBoard(app, carol, "runs-copy");
  });

  test("an empty title is refused in the action's words and nothing changes", async () => {
    const text = await screenText(carol, "n\r");
    expect(text).toContain("A title needs letters or digits.");
    expect(await slugs()).toEqual(["runs"]);
  });

  test("a non-admin is refused: n shows the refusal and nothing is made; c and D have no row to act on", async () => {
    for (const who of [bob, bot]) {
      expect(await screenText(who, "nSneaky\r")).toContain("That board is gone.");
      await screenText(who, "cDy");
    }
    expect(await slugs()).toEqual(["runs"]);
  });

  test("refusal words are the page's, cleaned for the terminal", () => {
    expect(refusal("not_found")).toBe("That board is gone.");
    expect(refusal({ refused: "bad\u001b[2J" })).toBe("That was refused: bad [2J.");
  });
});
