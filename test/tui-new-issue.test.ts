/**
 * A new issue from the terminal's palette: pick a repository you may write,
 * land on its new-issue form. A guest is not offered the row.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { scratchDir } from "./helpers/scratch.ts";
import { settleApp } from "./helpers/tui.ts";
import { proveAll } from "./helpers/verified.ts";

quietLogs();

let dir: string;
let app: App;
let alice: User;

async function drive(user: User | undefined, keys: string[]): Promise<string> {
  const terminal = headlessTerminal(120, 40);
  const { app: tui } = createForgeApp(
    app,
    { sshUsername: user?.username ?? "guest", remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", ...(user ? { user } : {}) },
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
  dir = scratchDir("forge-tui-new-issue-");
  app = createApp({ dataDir: dir, port: 0 });
  const r = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!r.ok) throw new Error(r.error);
  alice = r.value;
  proveAll(app);
  const made = await createRepo(app, alice, { name: "lobby", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
});
afterAll(async () => {
  app.db.close();
  await rm(dir, { recursive: true, force: true });
});

test("the palette row asks which repository, and enter opens its new-issue form", async () => {
  expect(await drive(alice, [":", "New issue", "\r"])).toContain("alice/lobby");
  const form = await drive(alice, [":", "New issue", "\r", "\r"]);
  expect(form).toContain("Title");
  expect(form).toContain("Description");
});

test("a guest is not offered the row", async () => {
  expect(await drive(undefined, [":", "New issue"])).not.toContain("pick a repository");
});
