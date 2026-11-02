/**
 * The terminal's Conversations screen (#8814): list, New, Rename and
 * Archive/Restore through the calls /talk uses, offered to a signed-in person
 * and not to an agent, with the cap refusing past it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { appendTurn, CONVERSATIONS_MAX, createConversation, listConversations, listTurns, renameConversation } from "../src/core/conversations.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";
import { proveAll } from "./helpers/verified.ts";

let dir: string;
let app: App;
let alice: User;
let bob: User;
const open = [":", "Conversations", "\r"];

async function drive(user: User, keys: string[]): Promise<string> {
  const terminal = headlessTerminal(120, 30);
  const { app: tui } = createForgeApp(
    app,
    { sshUsername: user.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user },
    { terminal, exitHooks: false },
  );
  tui.start();
  await settleApp(tui);
  for (const k of keys) {
    terminal.feed(k);
    await settleApp(tui);
  }
  const text = tui.screen.toText();
  tui.stop?.();
  return text;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-chats-"));
  app = createApp({ dataDir: dir, port: 0 });
  const mk = async (username: string, first = false) => {
    const r = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst: first });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  alice = await mk("alice", true);
  bob = await mk("bob");
  proveAll(app);
});
afterAll(async () => {
  app.db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("the terminal's conversations screen", () => {
  test("n starts one with a title, r renames it, x archives it and a brings it back", async () => {
    const text = await drive(alice, [...open, "n", "Weekly plan", "\r"]);
    const mine = listConversations(app.db, alice.id);
    expect(mine.map((c) => c.title)).toEqual(["Weekly plan"]);
    expect(text).toContain("Weekly plan");
    expect(text).toContain(`/talk/${mine[0]!.id}`);
    await drive(alice, [...open, "r", ..."\x7f".repeat(11).split(""), "Renamed", "\r"]);
    expect(listConversations(app.db, alice.id)[0]!.title).toBe("Renamed");
    await drive(alice, [...open, "x"]);
    expect(listConversations(app.db, alice.id)).toEqual([]);
    const archived = await drive(alice, [...open, "a"]);
    expect(archived).toContain("Renamed");
    expect(listConversations(app.db, alice.id, { archived: true }).length).toBe(1);
    await drive(alice, [...open, "a", "x"]);
    expect(listConversations(app.db, alice.id).length).toBe(1);
  });

  test("another person's conversations are not listed", async () => {
    const text = await drive(bob, open);
    expect(text).not.toContain("Renamed");
    expect(text).toContain("No conversations yet");
  });

  test("Enter opens one: its turns, and s says something in it", async () => {
    const made = createConversation(app.db, bob.id);
    if (!made.ok) throw new Error(made.error);
    renameConversation(app.db, bob.id, made.value.id, "Bob's chat");
    appendTurn(app.db, bob.id, made.value.id, { role: "person", text: "how is the forge" });
    appendTurn(app.db, bob.id, made.value.id, { role: "agent", text: "all green today" });
    const text = await drive(bob, [...open, "\r"]);
    expect(text).toContain("how is the forge");
    expect(text).toContain("all green today");
    expect(text).toContain(`/talk/${made.value.id}`);
    // The crew is off in this app: talk() refuses, the prompt says why, and nothing is stored.
    const said = await drive(bob, [...open, "\r", "s", "hello", "\r"]);
    expect(said).toContain("not running here");
    const turns = listTurns(app.db, bob.id, made.value.id, { limit: 50 });
    expect(turns.ok && turns.value.length).toBe(2);
  });

  test("past the cap, n says so and starts nothing", async () => {
    while (createConversation(app.db, alice.id).ok) { /* fill */ }
    const held = (app.db.query("SELECT COUNT(*) AS n FROM conversation WHERE user_id = ?1").get(alice.id) as { n: number }).n;
    expect(held).toBe(CONVERSATIONS_MAX);
    renameConversation(app.db, alice.id, listConversations(app.db, alice.id)[0]!.id, "top");
    const text = await drive(alice, [...open, "n", "one too many", "\r"]);
    expect(text).toContain("the most there can be");
    expect((app.db.query("SELECT COUNT(*) AS n FROM conversation WHERE user_id = ?1").get(alice.id) as { n: number }).n).toBe(CONVERSATIONS_MAX);
  });
});
