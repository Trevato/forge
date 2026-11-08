/**
 * `x` on the terminal's board screen removes the marked panel after `y/n`, as
 * the web's Remove does through `changeBoard`; only a forge admin is offered it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listPinned } from "../src/actions/board-pins.ts";
import { deleteBoard, showBoard, writeBoard } from "../src/actions/boards.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { boardScreen } from "../src/tui/screens/boards.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dir: string;
let app: App;
let carol: User;
let bob: User;

const panel = (title: string) => ({ title, chart: "number" as const, query: { source: "runs", aggregate: "count" }, w: 1, h: 1 });
const seed = async () => {
  const wrote = await writeBoard(app, carol, "runs", {
    title: "Runs this week", range: "7d", refresh: "off", panels: [panel("Alpha"), panel("Beta"), panel("Gamma")],
  });
  if (!wrote.ok) throw new Error(JSON.stringify(wrote.error));
};
const titles = async (): Promise<string[]> => {
  const shown = await showBoard(app, carol, "runs");
  return shown.ok ? shown.value.panels.map((p) => p.title) : [];
};

async function drive(user: User, keys: string[]): Promise<string[]> {
  const shown = await showBoard(app, carol, "runs");
  if (!shown.ok) throw new Error("no board");
  const terminal = headlessTerminal(120, 30);
  const { app: tui, session } = createForgeApp(app, { sshUsername: user.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user }, { terminal, exitHooks: false });
  tui.start();
  tui.ctx.push(boardScreen(tui.ctx, session, "runs", shown.value));
  await settleApp(tui);
  const seen: string[] = [];
  for (const key of keys) {
    terminal.feed(key);
    await settleApp(tui);
    seen.push(tui.screen.toText());
  }
  tui.stop?.();
  return seen;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-panel-remove-"));
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

describe("tui board panel remove", () => {
  test("x then y removes the marked panel and nothing else", async () => {
    await seed();
    const seen = await drive(carol, ["]", "x", "y"]);
    expect(seen[1]).toContain("remove Beta? y/n");
    expect(await titles()).toEqual(["Alpha", "Gamma"]);
    expect(seen[2]).not.toContain("Beta");
    expect(seen[2]).toContain("panel removed");
  });

  test("x then n, or esc, changes nothing", async () => {
    await seed();
    const seen = await drive(carol, ["x", "n", "x", "esc"]);
    expect(seen[0]).toContain("remove Alpha? y/n");
    expect(seen[1]).not.toContain("remove Alpha");
    expect(await titles()).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  test("the key line offers x to an admin and not to anyone else", async () => {
    await seed();
    expect((await drive(carol, ["j"]))[0]).toContain("x  remove panel");
    const other = await drive(bob, ["j", "x"]);
    expect(other[0]).not.toContain("remove panel");
    expect(other[1]).not.toContain("remove Alpha");
    expect(await titles()).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  test("a mark on the last panel lands on the new last one", async () => {
    await seed();
    const seen = await drive(carol, ["]", "]", "x", "y", "x"]);
    expect(await titles()).toEqual(["Alpha", "Beta"]);
    expect(seen[4]).toContain("remove Beta? y/n");
  });

  /** Open the screen as carol, press `before`, let another door `meanwhile` change the board, then press `after`. */
  async function race(before: string[], meanwhile: () => Promise<unknown>, after: string[]): Promise<string> {
    const shown = await showBoard(app, carol, "runs");
    if (!shown.ok) throw new Error("no board");
    const terminal = headlessTerminal(120, 30);
    const { app: tui, session } = createForgeApp(app, { sshUsername: "carol", remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user: carol }, { terminal, exitHooks: false });
    tui.start();
    tui.ctx.push(boardScreen(tui.ctx, session, "runs", shown.value));
    await settleApp(tui);
    for (const key of before) { terminal.feed(key); await settleApp(tui); }
    await meanwhile();
    for (const key of after) { terminal.feed(key); await settleApp(tui); }
    const text = tui.screen.toText();
    tui.stop?.();
    return text;
  }
  const rewrite = (titles: string[]) => () =>
    writeBoard(app, carol, "runs", { title: "Runs this week", range: "7d", refresh: "off", panels: titles.map(panel) });

  test("a board shortened elsewhere removes nothing, says so and shows the board as it is", async () => {
    await seed();
    const text = await race(["]", "]", "x"], rewrite(["Alpha"]), ["y"]);
    expect(text).toContain("The board changed; nothing was removed.");
    expect(text).toContain("1 panel");
    expect(text).not.toContain("Gamma");
    expect(await titles()).toEqual(["Alpha"]);
  });

  test("panels reordered elsewhere after the prompt: y removes nothing rather than the wrong panel", async () => {
    await seed();
    const text = await race(["]", "x"], rewrite(["Gamma", "Alpha", "Beta"]), ["y"]);
    expect(text).toContain("The board changed; nothing was removed.");
    expect(await titles()).toEqual(["Gamma", "Alpha", "Beta"]);
  });

  test("a board deleted elsewhere is refused in the page's words", async () => {
    await seed();
    const text = await race(["x"], () => deleteBoard(app, carol, "runs"), ["y"]);
    expect(text).toContain("That board is gone.");
    expect(text).toContain("Alpha");
  });

  test("a pinned panel that is removed leaves the screen working, and p pins its neighbour", async () => {
    await seed();
    const seen = await drive(carol, ["p", "x", "y", "p"]);
    expect(await titles()).toEqual(["Beta", "Gamma"]);
    expect(seen[2]).toContain("Beta");
    const pins = await listPinned(app, carol);
    expect(pins.ok && pins.value.map((p) => p.title)).toContain("Beta");
  });
});
