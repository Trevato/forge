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
import { appendTurn, archiveConversation, CONVERSATIONS_MAX, createConversation, listConversations, listTurns, renameConversation } from "../src/core/conversations.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createRepo } from "../src/actions/repos.ts";
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
    // A lone escape is held back a moment to tell it from a key sequence.
    if (k === "\x1b") await Bun.sleep(150);
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

  test("a tool call reads as a step, and the header names the repository it works on", async () => {
    const made = createConversation(app.db, bob.id);
    if (!made.ok) throw new Error(made.error);
    appendTurn(app.db, bob.id, made.value.id, { role: "tool", text: 'mcp__forge__read_file {"repo":"bob/site","path":"src/x.ts"}' });
    const text = await drive(bob, [...open, "\r"]);
    expect(text).toContain("Read src/x.ts");
    expect(text).toContain("working on bob/site");
    expect(text).not.toContain("mcp__forge__read_file");
  });

  test("p shows what the chat works on, as the web's pane does; a repository it cannot read shows nothing of it", async () => {
    const made = createConversation(app.db, alice.id);
    if (!made.ok) throw new Error(made.error);
    const repo = await createRepo(app, alice, { name: "pane", visibility: "public" });
    if (!repo.ok) throw new Error(repo.error);
    appendTurn(app.db, alice.id, made.value.id, { role: "tool", text: 'mcp__forge__write_file {"repo":"alice/pane","path":"src/y.ts","content":"a"}' });
    const text = await drive(alice, [...open, "\r", "p"]);
    expect(text).toContain("alice/pane · Production");
    expect(text).toContain("Nothing running yet.");
    expect(text).toContain("No open pull yet.");
    expect(text).toContain("src/y.ts");
    const hidden = createConversation(app.db, alice.id);
    if (!hidden.ok) throw new Error(hidden.error);
    appendTurn(app.db, alice.id, hidden.value.id, { role: "tool", text: 'mcp__forge__read_file {"repo":"alice/nothere","path":"a"}' });
    expect(await drive(alice, [...open, "\r", "p"])).toContain("Not a repository you can see.");
  });

  test("turns are read when the chat opens and on r, not on every draw", async () => {
    const made = createConversation(app.db, bob.id);
    if (!made.ok) throw new Error(made.error);
    appendTurn(app.db, bob.id, made.value.id, { role: "person", text: "first words" });
    const terminal = headlessTerminal(120, 30);
    const { app: tui } = createForgeApp(app, { sshUsername: bob.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user: bob }, { terminal, exitHooks: false });
    tui.start();
    for (const k of [...open, "\r"]) { terminal.feed(k); await settleApp(tui); }
    appendTurn(app.db, bob.id, made.value.id, { role: "person", text: "later words" });
    terminal.feed("p"); await settleApp(tui);
    terminal.feed("p"); await settleApp(tui);
    expect(tui.screen.toText()).not.toContain("later words");
    terminal.feed("r"); await settleApp(tui);
    expect(tui.screen.toText()).toContain("later words");
    tui.stop?.();
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

  test("/ searches the person's own conversations, archived too, and Enter opens at the match", async () => {
    const mine = createConversation(app.db, bob.id);
    // Alice is at the cap from the test above: her newest conversation is the other person's.
    const theirs = { ok: true as const, value: listConversations(app.db, alice.id)[0]! };
    if (!mine.ok) throw new Error("conversation");
    renameConversation(app.db, bob.id, mine.value.id, "Harbour notes");
    const hit = appendTurn(app.db, bob.id, mine.value.id, { role: "person", text: "the quokka migration plan" });
    for (let i = 0; i < 70; i++) appendTurn(app.db, bob.id, mine.value.id, { role: "agent", text: `later ${i}` });
    appendTurn(app.db, alice.id, theirs.value.id, { role: "person", text: "alice quokka secret" });
    archiveConversation(app.db, bob.id, mine.value.id, true);
    const found = await drive(bob, [...open, "/", "quokk", "\r"]);
    expect(found).toContain("Harbour notes");
    expect(found).toContain("archived");
    expect(found).not.toContain("secret");
    expect(found).not.toContain(theirs.value.id);
    const opened = await drive(bob, [...open, "/", "quokk", "\r", "\r"]);
    expect(opened).toContain("the quokka migration plan");
    expect(opened).toContain("▶");
    expect(hit.ok).toBe(true);
    const none = await drive(bob, [...open, "/", "zzzqqq", "\r"]);
    expect(none).toContain("Nothing found");
    const back = await drive(bob, [...open, "/", "quokk", "\r", "\x1b"]);
    expect(back).not.toContain("Found for");
  });
});
