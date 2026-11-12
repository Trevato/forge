/** The terminal's drifting-pulls screen: offered to a person admin only, says nothing drifts, and asks the agent as the route does. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent } from "../src/actions/crew.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser, type User } from "../src/core/users.ts";
import type { Repo } from "../src/core/repos.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { ENTRIES } from "../src/tui/screens/entries.ts";
import { askUpdate, driftRows, driftScreen, entry } from "../src/tui/screens/drift.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dataDir: string;
let app: App;
let alice: User;
let bob: User;
let repo: Repo;

const open = (user: User) =>
  createForgeApp(app, { sshUsername: user.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:t", user }, { terminal: headlessTerminal(120, 30), exitHooks: false });

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-tui-drift-"));
  app = createApp({ dataDir, port: 0 });
  const mk = async (username: string) => {
    const u = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst: username === "alice" });
    if (!u.ok) throw new Error(String(u.error));
    return u.value;
  };
  alice = await mk("alice");
  bob = await mk("bob");
  const made = await createRepo(app, alice, { name: "notes", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  repo = made.value;
  await commitToBranch(app, alice, repo, { message: "base", files: [{ path: "a.txt", content: "a\n" }] });
}, 30_000);

afterAll(async () => {
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("the entry is in the palette list and offered to a person admin alone", () => {
  expect(ENTRIES).toContain(entry);
  const a = open(alice);
  const b = open(bob);
  expect(entry.offered(a.session)).toBe(true);
  expect(entry.offered(b.session)).toBe(false);
});

test("rows say landings and hours; an empty forge says nothing drifts", async () => {
  expect(driftRows([{ repo: "alice/notes", number: 3, landings: 26, hours: 1.5 }])).toEqual([
    { title: "alice/notes #3", meta: expect.stringContaining("26 landings") },
  ]);
  const { app: tui, session } = open(alice);
  tui.start();
  await settleApp(tui);
  tui.push(driftScreen(session, tui.ctx));
  await settleApp(tui);
  expect(tui.screen.toText()).toContain("Nothing drifts");
  tui.stop();
});

test("asking: a writer's agent is named, a reader is refused", async () => {
  const c = await commitToBranch(app, alice, repo, { branch: "w", message: "w", files: [{ path: "w.txt", content: "w\n" }] });
  if (!c.ok) throw new Error(JSON.stringify(c.error));
  const opened = await openPull(app, alice, repo, { title: "w", baseBranch: "main", headBranch: "w" });
  if (!opened.ok) throw new Error(String(opened.error));
  const agent = await createAgent(app, alice, { username: "bot" });
  if (!agent.ok) throw new Error(JSON.stringify(agent.error));
  app.db.query("UPDATE issue SET assignee_id = ?1 WHERE id = ?2").run(agent.value.user.id, opened.value.id);
  const p = { repo: "alice/notes", number: opened.value.number, landings: 30, hours: 0 };
  const refused = askUpdate(open(bob).session, p);
  expect(refused.ok).toBe(false);
  expect(refused.says).toContain("Only someone who can write");
  const done = askUpdate(open(alice).session, p);
  expect(done.ok).toBe(true);
  expect(done.says).toContain("bot is bringing");
});
