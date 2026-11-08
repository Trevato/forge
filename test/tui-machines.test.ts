/**
 * A repository's machines and last shell sessions in the terminal (#9471),
 * the door beside Settings → Machines: a writer sees the machines and each
 * session's machine, owner and end; a reader sees neither.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App as Forge } from "../src/app.ts";
import { createRepo, type Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { recordEnd, recordStart } from "../src/machines/shell.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dataDir: string;
let forge: Forge;
let repo: Repo;
const people: Record<string, User> = {};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-tui-machines-"));
  forge = createApp({ dataDir, port: 0 });
  for (const name of ["alice", "bob"]) {
    const made = await createUser(forge.db, { origin: "seed", trusted: true, username: name, email: `${name}@forge.local`, password: "a-good-passphrase" });
    if (!made.ok) throw new Error(made.error);
    people[name] = made.value;
  }
  const made = await createRepo(forge.db, forge.reposRoot, { ownerId: people["alice"]!.id, name: "lab", visibility: "public" });
  if (!made.ok) throw new Error(made.error);
  repo = made.value;
  recordEnd(forge.db, recordStart(forge.db, repo.id, "standard", people["alice"]!.id), "idle");
});

afterAll(async () => {
  forge.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function machinesAs(user: User): Promise<string> {
  const terminal = headlessTerminal(140, 32);
  const identity: TuiIdentity = { sshUsername: "t", remoteAddress: "127.0.0.1", user };
  const { app } = createForgeApp(forge, identity, { terminal, exitHooks: false });
  app.start();
  const key = (k: string, ctrl = false) => app.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
  await settleApp(app);
  key("k", true);
  await settleApp(app);
  for (const ch of "Machines of a repository") key(ch);
  await settleApp(app);
  key("enter");
  await settleApp(app);
  for (const ch of "alice/lab") key(ch);
  await settleApp(app);
  key("enter");
  await settleApp(app);
  await Bun.sleep(50);
  await settleApp(app);
  const text = app.screen.toText();
  app.stop();
  return text;
}

test("a writer sees the machines and the last sessions", async () => {
  const text = await machinesAs(people["alice"]!);
  expect(text).toContain("Machines: standard; security");
  expect(text).toContain("standard · alice");
  expect(text).toContain("idle too long");
});

test("a reader sees neither", async () => {
  const text = await machinesAs(people["bob"]!);
  expect(text).toContain("writers'");
  expect(text).not.toContain("standard · alice");
});
