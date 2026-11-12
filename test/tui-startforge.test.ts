/**
 * "Start my forge" in the terminal: a guest's start, through the same
 * `spawnDoor` as the home page's form, the claim link once, refusals in the
 * home page's fixed sentences.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser, type User } from "../src/core/users.ts";
import { usePlacement, useProbe } from "../src/spawn/door.ts";
import { hostedPlacement } from "../src/spawn/placement.ts";
import { createForgeApp, forgeCommands, Session } from "../src/tui/forge.ts";
import { startForgeScreen } from "../src/tui/screens/startforge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { START_REFUSALS } from "../src/web/start_refusal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dir: string;
let app: App;
let bob: User;
const identity = (user?: User) => ({ sshUsername: user?.username ?? "git", remoteAddress: "203.0.113.9", fingerprint: "SHA256:test", user });
const children = async () => (await readdir(join(dir, "spawn")).catch(() => [] as string[])).length;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-startforge-"));
  app = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
  const r = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "bob@forge.local", password: "a-good-passphrase", isAdmin: false });
  if (!r.ok) throw new Error(r.error);
  bob = r.value;
  useProbe(app, () => async () => true);
  usePlacement(app, hostedPlacement({ host: "forge.test" }));
});
afterAll(async () => {
  app.db.close();
  await rm(dir, { recursive: true, force: true });
});

async function withScreen(body: (h: { tui: ReturnType<typeof createForgeApp>["app"]; terminal: ReturnType<typeof headlessTerminal> }) => Promise<void>) {
  const terminal = headlessTerminal(120, 30);
  const { app: tui, session } = createForgeApp(app, identity(), { terminal, exitHooks: false });
  tui.start();
  tui.ctx.push(startForgeScreen(session, tui.ctx));
  try {
    await settleApp(tui);
    await body({ tui, terminal });
  } finally {
    tui.stop?.();
  }
}

test("the palette offers it to a guest; a signed-in person has New forge instead", () => {
  const ids = (u?: User) => forgeCommands(new Session(app, identity(u)))({} as never).map((c) => c.id);
  expect(ids()).toContain("start-forge");
  expect(ids(bob)).not.toContain("start-forge");
  expect(ids(bob)).toContain("new-forge");
});

test("a bad name is refused in the home page's words and nothing is made", () =>
  withScreen(async ({ tui, terminal }) => {
    const before = await children();
    terminal.feed("-bad-\r");
    await settleApp(tui);
    expect(tui.screen.toText().replace(/\s+/g, " ")).toContain(START_REFUSALS.name);
    expect(await children()).toBe(before);
  }));

test("a name and Enter make the forge through the door and show its claim link", () =>
  withScreen(async ({ tui, terminal }) => {
    const before = await children();
    expect(tui.screen.toText()).toContain("Forge name");
    terminal.feed("Sunny-Day\r");
    await settleApp(tui);
    expect(await children()).toBe(before + 1);
    expect(tui.screen.toText()).toMatch(/https:\/\/sunny-day--forge\.test\/claim#/);
  }));
