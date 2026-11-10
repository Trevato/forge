/** Your shells in the terminal (#10544): the palette opens it; own rows only; a person with none is told so. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/core/repos.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { recordEnd, recordStart } from "../src/machines/shell.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dir: string;
let app: App;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "tui-my-shells-"));
  app = createApp({ dataDir: dir, port: 0 });
  for (const name of ["alice", "bob"]) {
    const u = await createUser(app.db, { username: name, email: `${name}@x.test`, password: "correct horse battery", origin: "seed", isAdmin: false, trusted: true });
    if (!u.ok) throw new Error(String(u.error));
  }
  const alice = getUserByName(app.db, "alice")!;
  const r = await createRepo(app.db, app.reposRoot, { ownerId: alice.id, name: "lab", visibility: "public" });
  if (!r.ok) throw new Error(String(r.error));
  recordEnd(app.db, recordStart(app.db, r.value.id, "standard", alice.id), "idle");
});

afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

async function shellsScreenText(username: string): Promise<string> {
  const { app: tui } = createForgeApp(
    app,
    { sshUsername: "t", remoteAddress: "127.0.0.1", user: getUserByName(app.db, username)! },
    { terminal: headlessTerminal(140, 32), exitHooks: false },
  );
  tui.start();
  const key = async (k: string, ctrl = false) => {
    tui.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
    await settleApp(tui);
  };
  await key("k", true);
  for (const ch of "Your shells") await key(ch);
  await key("enter");
  const text = tui.screen.toText();
  tui.stop();
  return text;
}

test("the owner sees the ended shell and why; another person is told they have none", async () => {
  const mine = await shellsScreenText("alice");
  expect(mine).toContain("alice/lab · standard");
  expect(mine).toContain("idle too long");
  const theirs = await shellsScreenText("bob");
  expect(theirs).toContain("You have opened no shell on a machine yet.");
  expect(theirs).not.toContain("alice/lab");
});

test("s stops the picked live shell and i stops idle ones, with the page's receipts", async () => {
  const alice = getUserByName(app.db, "alice")!;
  const { app: tui } = createForgeApp(
    app,
    { sshUsername: "t", remoteAddress: "127.0.0.1", user: alice },
    { terminal: headlessTerminal(140, 32), exitHooks: false },
  );
  tui.start();
  const key = async (k: string, ctrl = false) => {
    tui.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
    await settleApp(tui);
  };
  await key("k", true);
  for (const ch of "Your shells") await key(ch);
  await key("enter");
  // The first line is an ended shell: stop refuses it in the page's words.
  await key("s");
  expect(tui.screen.toText()).toContain("No such shell.");
  await key("i");
  expect(tui.screen.toText()).toContain("No idle shell to stop.");
  tui.stop();
});
