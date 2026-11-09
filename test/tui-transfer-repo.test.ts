/**
 * Moving a repository from the terminal's `:` palette (#569): an admin types
 * the new owner and the repository moves; a refusal says why in the API's
 * words; a writer who is not an admin, and an agent, are never offered it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { addTeamMember, createOrg, createTeam } from "../src/core/orgs.ts";
import { canAdmin, canWrite, getRepoById, type Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import type { Screen } from "../src/tui/app/app.ts";
import { style } from "../src/tui/term/style.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { transferRepoCommands } from "../src/tui/screens/transferrepo.ts";
import { getRepo } from "../src/core/repos.ts";
import { repoScreen } from "../src/tui/screens/repo.ts";
import { local } from "../src/tui/screens/where.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";
import { proveAll } from "./helpers/verified.ts";

quietLogs();

let dir: string;
let app: App;
let alice: User;
let bob: User;
let bot: User;

const KEYS: Record<string, string> = { enter: "\r" };

/** A screen that says it is beneath the repository's, so a test can see where the unwinding landed. */
const below: Screen = {
  title: "below",
  keys: [],
  render: (area, s) => void s.text(area.x, area.y, "BELOW-THE-REPO", style(0, 0), area.x + area.w),
  key: () => false,
};

function open(user: User, at: Repo, nested = false) {
  const terminal = headlessTerminal(120, 40);
  const { app: tui, session } = createForgeApp(
    app,
    { sshUsername: user.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user },
    { terminal, exitHooks: false },
  );
  tui.start();
  if (nested) tui.ctx.push(below);
  tui.ctx.push(repoScreen(session, tui.ctx, local(session, at)));
  return {
    session,
    ctx: tui.ctx,
    text: () => tui.screen.toText(),
    feed: async (...keys: string[]) => {
      for (const k of keys) {
        terminal.feed(KEYS[k] ?? k);
        await settleApp(tui);
      }
    },
    stop: () => tui.stop?.(),
  };
}

/** Open the delete prompt from the palette once its row has drawn. */
async function prompt(h: ReturnType<typeof open>): Promise<void> {
  await h.feed(":", ..."Move this");
  for (let i = 0; i < 100 && !h.text().includes("old links answer"); i++)
    await new Promise<void>((r) => setTimeout(r, 10)), await h.feed();
  if (!h.text().includes("old links answer")) throw new Error(`never came: still waiting while !h.text().includes("old links answer")`);
  await h.feed("enter");
}

async function mkRepo(owner: string | undefined, name: string): Promise<Repo> {
  const made = await createRepo(app, alice, { ...(owner ? { owner } : {}), name, visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  return made.value;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-transfer-repo-"));
  app = createApp({ dataDir: dir, port: 0 });
  const mk = async (username: string, first = false) => {
    const r = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: first,
    });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  alice = await mk("alice", true);
  bob = await mk("bob");
  bot = await mk("crewbot1");
  // An agent that is also a forge admin: canAdmin accepts it, so only the kind check keeps it out.
  app.db.query("UPDATE user SET is_agent = 1, is_admin = 1 WHERE id = ?1").run(bot.id);
  bot = { ...bot, kind: "agent", isAdmin: true };
  proveAll(app);
});
afterAll(async () => {
  app.db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("move a repository in the terminal", () => {
  test("an admin who types an org's name moves the repository there", async () => {
    const org = createOrg(app.db, "lab", alice.id);
    if (!org.ok) throw new Error(org.error);
    const repo = await mkRepo(undefined, "wander");
    const h = open(alice, repo);
    await prompt(h);
    expect(h.text()).toContain("alice/wander");
    await h.feed(..."lab", "enter");
    expect(getRepoById(app.db, repo.id)?.ownerName).toBe("lab");
    expect(h.text()).toContain("moved alice/wander to lab/wander");
    h.stop();
  });

  test("a refusal is said in the API's words and the repository stays", async () => {
    await mkRepo("lab", "taken");
    const repo = await mkRepo(undefined, "taken");
    const h = open(alice, repo);
    await prompt(h);
    await h.feed(..."lab", "enter");
    expect(h.text()).toContain("already has a repository by that name");
    expect(getRepo(app.db, "alice", "taken")?.id).toBe(repo.id);
    h.stop();
  });

  test("a writer who is not an admin, and an agent, are not offered it", async () => {
    const org = createOrg(app.db, "acme", alice.id);
    if (!org.ok) throw new Error(org.error);
    const devs = createTeam(app.db, org.value.id, "devs", "write");
    if (!devs.ok) throw new Error(devs.error);
    addTeamMember(app.db, devs.value, bob.id);
    const shop = await mkRepo("acme", "shop");
    expect(canWrite(app.db, shop, bob)).toBe(true);
    expect(canAdmin(app.db, shop, bot)).toBe(true);
    for (const who of [bob, bot]) {
      const h = open(who, shop);
      expect(transferRepoCommands(h.session, h.ctx, shop)).toEqual([]);
      h.stop();
    }
    const h = open(alice, shop);
    expect(transferRepoCommands(h.session, h.ctx, shop).map((c) => c.title)).toEqual([
      "acme/shop — Move this repository to another owner",
    ]);
    h.stop();
  });
});
