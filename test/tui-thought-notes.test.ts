/**
 * /notes in the terminal (#8696): a note written there is the same row the
 * page lists, a guest has nothing, and the overrule is the line's own tap.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { thoughtStream } from "../src/core/thought_stream.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { notesScreen, noteRows } from "../src/tui/screens/thoughtnotes.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dir: string;
let app: App;
let alice: User;
let bob: User;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-thought-notes-"));
  app = createApp({ dataDir: dir, port: 0 });
  const mk = async (username: string, first = false) => {
    const r = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", ...(first ? { admin: true } : {}) });
    if (!r.ok) throw new Error(String(r.error));
    return r.value;
  };
  alice = await mk("alice", true);
  bob = await mk("bob");
});
afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

async function drive(user: User | undefined, keys: string): Promise<string> {
  const terminal = headlessTerminal(120, 30);
  const { app: tui, session } = createForgeApp(
    app,
    { sshUsername: user?.username ?? "git", remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user },
    { terminal, exitHooks: false },
  );
  tui.start();
  tui.ctx.push(notesScreen(session, tui.ctx));
  await settleApp(tui);
  terminal.feed(keys);
  await settleApp(tui);
  const text = tui.screen.toText();
  tui.stop?.();
  return text;
}

test("a note written in the terminal is the page's row, and only its author's", async () => {
  const text = await drive(alice, "nbuild a sparkline for spend\r");
  expect(text).toContain("build a sparkline for spend");
  expect(text).toContain("Waiting for the planner");
  expect(thoughtStream(app.db, alice).map((n) => n.text)).toEqual(["build a sparkline for spend"]);
  expect(noteRows(app.db, bob)).toEqual([]);
  expect(noteRows(app.db, undefined)).toEqual([]);
  expect(await drive(bob, "")).toContain("No notes yet");
});

test("nothing typed saves nothing", async () => {
  await drive(bob, "n\r");
  expect(thoughtStream(app.db, bob)).toHaveLength(0);
});
