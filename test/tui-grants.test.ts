/**
 * Crew grants in the terminal: a repository admin who is a forge admin ticks
 * subscriptions per crew member; clearing a row falls back to the wider
 * grant; a non-admin and an agent are refused and offered no key.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { addCrew, createAgentRow, removeCrew } from "../src/core/agents.ts";
import { type Repo } from "../src/core/repos.ts";
import { EVERYONE, addSubscription, listGrants, setGrants } from "../src/core/subscriptions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { grantsCommands, grantsScreen } from "../src/tui/screens/grants.ts";
import { repoScreen } from "../src/tui/screens/repo.ts";
import { local } from "../src/tui/screens/where.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dir: string;
let app: App;
let alice: User;
let bob: User;
let bot: User;
let stranger: User;
let repo: Repo;
let subA: string;
let subB: string;

const SECRET = "sk-ant-api03-grantsecret";

function open(user: User, width = 140) {
  const terminal = headlessTerminal(width, 40);
  const { app: tui, session } = createForgeApp(
    app,
    { sshUsername: user.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user },
    { terminal, exitHooks: false },
  );
  tui.start();
  tui.ctx.push(repoScreen(session, tui.ctx, local(session, repo)));
  return {
    session,
    ctx: tui.ctx,
    text: () => tui.screen.toText(),
    feed: async (...keys: string[]) => {
      for (const k of keys) {
        terminal.feed(k);
        await settleApp(tui);
      }
    },
    stop: () => tui.stop?.(),
  };
}

async function grants(h: ReturnType<typeof open>): Promise<void> {
  await h.feed(":", ..."Crew grants");
  for (let i = 0; i < 100 && !h.text().includes("which subscriptions each"); i++)
    await new Promise<void>((r) => setTimeout(r, 10)), await h.feed();
  if (!h.text().includes("which subscriptions each")) throw new Error(`never came: still waiting while !h.text().includes("which subscriptions each")`);
  await h.feed("\r");
}

const mk = async (username: string, admin: boolean): Promise<User> => {
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username,
    email: `${username}@forge.local`,
    password: "a-good-passphrase",
    adminIfFirst: admin,
  });
  if (!made.ok) throw new Error(made.error);
  return made.value;
};

const own = (agentId: string): string[] =>
  listGrants(app.db, repo.id).filter((g) => g.agentId === agentId).map((g) => g.subscriptionId).sort();

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-grants-"));
  app = createApp({ dataDir: dir, port: 0 });
  alice = await mk("alice", true);
  bob = await mk("bob", false);
  stranger = await mk("stranger", false);
  bot = await mk("bot1", false);
  createAgentRow(app.db, { userId: bot.id, model: "opus" });
  app.db.query("UPDATE user SET is_admin = 1, is_agent = 1 WHERE username = 'bot1'").run();
  bot = { ...bot, isAdmin: true, kind: "agent" } as User;
  const made = await createRepo(app, alice, { name: "grants", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  repo = made.value;
  addCrew(app.db, repo.id, bot.id);
  const a = addSubscription(app.db, dir, { name: "Alpha", token: SECRET });
  const b = addSubscription(app.db, dir, { name: "Beta", token: "sk-ant-api03-other" });
  if (!a.ok || !b.ok) throw new Error("subscription");
  subA = a.value.id;
  subB = b.value.id;
});
afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("crew grants in the terminal", () => {
  test("a toggle is saved on the selected row, whole, and never shows a token", async () => {
    const h = open(alice);
    await grants(h);
    expect(h.text()).toContain("Everyone on the crew");
    expect(h.text()).toContain("bot1");
    expect(h.text()).not.toContain(SECRET);
    await h.feed(" ");
    expect(own(EVERYONE)).toEqual([subA]);
    await h.feed("l", " ");
    expect(own(EVERYONE).sort()).toEqual([subA, subB].sort());
    await h.feed("j", " ");
    expect(own(bot.id)).toEqual([subB]);
    expect(own(EVERYONE).length).toBe(2);
    h.stop();
  });

  test("clearing a row removes its grant and says the wider one applies", async () => {
    const h = open(alice);
    await grants(h);
    expect(h.text()).toContain("the wider grant applies");
    h.stop();
    setGrants(app.db, repo.id, bot.id, [subB]);
    const g = open(alice);
    await grants(g);
    await g.feed("j", "l", " ");
    expect(own(bot.id)).toEqual([]);
    expect(g.text()).toContain("the wider grant applies");
    g.stop();
  });

  test("a row whose agent left the crew is not written", async () => {
    setGrants(app.db, repo.id, bot.id, []);
    const h = open(alice);
    await grants(h);
    await h.feed("j"); // the cursor is on bot1
    removeCrew(app.db, repo.id, bot.id);
    await h.feed(" ");
    expect(own(bot.id)).toEqual([]);
    expect(h.text()).toContain("That row is no longer on the crew.");
    h.stop();
    addCrew(app.db, repo.id, bot.id);
  });

  test("the palette offers Crew grants to the forge admin", () => {
    const h = open(alice);
    const cmds = grantsCommands(h.session, h.ctx, repo);
    expect(cmds.map((c) => c.title)).toEqual(["Crew grants"]);
    expect(grantsScreen(h.session, h.ctx, repo).title).toBe("Crew grants");
    h.stop();
  });

  test("a non-admin and an agent get an empty screen and no key", async () => {
    for (const who of [bob, stranger, bot]) {
      const before = JSON.stringify(listGrants(app.db, repo.id));
      const h = open(who);
      const cmd = grantsCommands(h.session, h.ctx, repo);
      expect(cmd).toEqual([]);
      // Even pushed by hand, the screen is empty, offers no key and writes nothing.
      const screen = grantsScreen(h.session, h.ctx, repo);
      expect(screen.keys).toEqual([]);
      expect(screen.key({ type: "key", key: " ", ctrl: false, alt: false, shift: false })).toBe(false);
      h.stop();
      expect(JSON.stringify(listGrants(app.db, repo.id))).toBe(before);
    }
  });

  test("on a narrow terminal the cursor's subscription stays in view", async () => {
    for (const name of ["Gamma", "Delta", "Epsilon", "Zeta"]) {
      const made = addSubscription(app.db, dir, { name, token: `sk-ant-api03-${name}` });
      if (!made.ok) throw new Error("subscription");
    }
    const h = open(alice, 50);
    await grants(h);
    await h.feed("l", "l", "l", "l", "l");
    expect(h.text()).toMatch(/>\[[ x]\] Zeta/);
    h.stop();
  });
});
