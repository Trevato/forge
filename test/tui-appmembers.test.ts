/**
 * The deploys screen's `m` (#7418): the people a private app names, from the
 * terminal. A writer lets carol in with `a`, sees the plan, confirms, and
 * carol may enter the app; `d` and a confirm let her out, and she may not.
 * Cancelling a plan changes nothing. An unknown username is refused in MCP
 * `app_members`'s words. A confirm applies its own change to the list as it
 * stands then, so a change another writer made meanwhile is kept. An agent
 * on the crew is not offered `m`. A public app has no `m`.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setAppMembersThrough } from "../src/actions/app_members.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createApp as createAppRecord, type AppRecord } from "../src/core/apps.ts";
import { canEnterApp, type Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { planLines } from "../src/tui/screens/appmembers.ts";
import { deploysScreen } from "../src/tui/screens/deploys.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dir: string;
let app: App;
let alice: User;
let carol: User;
let dave: User;
let bot: User;
let shop: Repo;
let open: Repo;
let record: AppRecord;

const LEFT = "\x1b[D";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-appmembers-"));
  app = createApp({ dataDir: dir, port: 0 });
  const mk = async (username: string, first = false): Promise<User> => {
    const r = await createUser(app.db, {
      origin: "seed", trusted: true, username, email: `${username}@forge.local`,
      password: "a-good-passphrase", adminIfFirst: first,
    });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  alice = await mk("alice", true);
  carol = await mk("carol");
  dave = await mk("dave");
  const agent = await createAgent(app, alice, { username: "bot" });
  if (!agent.ok) throw new Error(String(agent.error));
  bot = agent.value.user;
  const repoOf = async (name: string): Promise<Repo> => {
    const r = await createRepo(app, alice, { name, visibility: "public" });
    if (!r.ok) throw new Error("repo failed");
    return r.value;
  };
  shop = await repoOf("shop");
  open = await repoOf("open");
  const made = createAppRecord(app.db, { repoId: shop.id, slug: "shop", access: "private" });
  if (!made.ok) throw new Error(made.error);
  record = made.value;
  if (!createAppRecord(app.db, { repoId: open.id, slug: "open", access: "public" }).ok) throw new Error("app");
  expect(addToCrew(app, alice, shop, "bot").ok).toBe(true);
});

afterAll(async () => {
  app.db.close();
  await rm(dir, { recursive: true, force: true });
});

/** The deploys screen of `of` as `who`, fed `keys` one chunk at a time; every frame. */
async function drive(who: User, of: Repo, keys: readonly (string | (() => void))[]): Promise<string[]> {
  const terminal = headlessTerminal(160, 40);
  const { app: tui, session } = createForgeApp(
    app,
    { sshUsername: who.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user: who },
    { terminal, exitHooks: false },
  );
  tui.start();
  await settleApp(tui);
  tui.push(deploysScreen(session, tui.ctx, of));
  await settleApp(tui);
  const frames = [tui.screen.toText()];
  for (const k of keys) {
    // A function is someone else acting between two keys.
    if (typeof k === "function") k();
    else terminal.feed(k);
    await settleApp(tui);
    frames.push(tui.screen.toText());
  }
  tui.stop();
  return frames;
}

const enters = (u: User): boolean => canEnterApp(app.db, shop, record, u);

test("a private app's writer is offered `m members` on the deploys screen", async () => {
  const [first] = await drive(alice, shop, []);
  expect(first).toContain("m  members");
});

test("`a` plans letting carol in, and only the confirm lets her in", async () => {
  expect(enters(carol)).toBe(false);
  const frames = await drive(alice, shop, ["m", "a", "carol", "\r"]);
  // The plan, shown before anything changed.
  expect(frames.at(-1)).toContain("Let in: carol");
  expect(enters(carol)).toBe(false);
  // Cancel is one step left of the chosen action.
  await drive(alice, shop, ["m", "a", "carol", "\r", LEFT, "\r"]);
  expect(enters(carol)).toBe(false);
  const done = await drive(alice, shop, ["m", "a", "carol", "\r", "\r"]);
  expect(enters(carol)).toBe(true);
  expect(done.at(-1)).toContain("Let in: carol.");
  expect(done.at(-1)).toContain("carol");
});

test("`d` plans letting the selected person out, and the confirm does", async () => {
  expect(enters(carol)).toBe(true);
  const frames = await drive(alice, shop, ["m", "d"]);
  expect(frames.at(-1)).toContain("Let out: carol");
  expect(enters(carol)).toBe(true);
  const done = await drive(alice, shop, ["m", "d", "\r"]);
  expect(enters(carol)).toBe(false);
  expect(done.at(-1)).toContain("Let out: carol.");
});

test("an unknown username is refused in MCP `app_members`'s words, and nobody is let in", async () => {
  const frames = await drive(alice, shop, ["m", "a", "nobody-here", "\r"]);
  const refused = setAppMembersThrough(app, alice, shop, { members: ["nobody-here"] });
  expect(refused.ok).toBe(false);
  const words = !refused.ok && refused.error.kind === "invalid" ? refused.error.message : "";
  expect(words).toBe("nobody-here is not a person's account here");
  expect(frames.at(-1)).toContain(words);
  expect(frames.at(-1)).not.toContain("Let in:");
  // The prompt stays open, holding what was typed, to be corrected.
  expect(frames.at(-1)).toContain("Let someone in");
  expect(frames.at(-1)).toContain("their username");
});

test("letting in someone already named says so and opens no confirm", async () => {
  expect(setAppMembersThrough(app, alice, shop, { members: ["carol"], dryRun: false }).ok).toBe(true);
  const frames = await drive(alice, shop, ["m", "a", "carol", "\r"]);
  expect(frames.at(-1)).toContain("Nobody is let in or out: the list already says so.");
  expect(frames.at(-1)).not.toContain("Let in:");
  expect(frames.at(-1)).not.toContain("Cancel");
  expect(enters(carol)).toBe(true);
});

test("a confirm applies only its own change: a person another writer named meanwhile stays named", async () => {
  expect(setAppMembersThrough(app, alice, shop, { members: [], dryRun: false }).ok).toBe(true);
  // Alice plans carol in; while the confirm stands open, dave is named on the page.
  const nameDave = (): void => {
    expect(setAppMembersThrough(app, alice, shop, { members: ["dave"], dryRun: false }).ok).toBe(true);
  };
  await drive(alice, shop, ["m", "a", "carol", "\r", nameDave, "\r"]);
  expect(enters(carol)).toBe(true);
  expect(enters(dave)).toBe(true);
  // Alice plans carol out; meanwhile dave is let out elsewhere, and the
  // confirm does not name him again from the screen's old list.
  const dropDave = (): void => {
    expect(setAppMembersThrough(app, alice, shop, { members: ["carol"], dryRun: false }).ok).toBe(true);
  };
  const frames = await drive(alice, shop, ["m", "d", dropDave, "\r"]);
  // The row `d` took was carol's, whatever order the list is in: the plan names her alone.
  expect(frames[2]).toContain("Let out: carol");
  expect(frames[2]).not.toContain("Let out: carol, dave");
  expect(frames[2]).not.toContain("Let out: dave");
  expect(enters(carol)).toBe(false);
  expect(enters(dave)).toBe(false);
});

test("an agent on the crew is not offered `m`, and pressing it opens nothing", async () => {
  expect(setAppMembersThrough(app, alice, shop, { members: ["carol"], dryRun: false }).ok).toBe(true);
  const frames = await drive(bot, shop, ["m", "a", "d"]);
  expect(frames[0]).toContain("production deploys");
  expect(frames[0]).not.toContain("m  members");
  for (const frame of frames.slice(1)) {
    expect(frame).toContain("production deploys");
    expect(frame).not.toContain("Members");
    expect(frame).not.toContain("Let in:");
    expect(frame).not.toContain("Let out:");
  }
  expect(enters(carol)).toBe(true);
});

test("a public app is not offered `m`, and pressing it opens nothing", async () => {
  const frames = await drive(alice, open, ["m"]);
  expect(frames[0]).not.toContain("m  members");
  expect(frames.at(-1)).not.toContain("names nobody");
  expect(frames.at(-1)).toContain("production deploys");
});

test("the plan says each side that moves, and only those", () => {
  expect(planLines({ added: ["carol"], removed: [] })).toEqual(["Let in: carol"]);
  expect(planLines({ added: [], removed: ["dave", "erin"] })).toEqual(["Let out: dave, erin"]);
  expect(planLines({ added: [], removed: [] })).toEqual([]);
});
