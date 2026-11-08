/** The terminal's dashboard draws each fired flow alarm in one line for an admin; anyone else reads public repositories alone (#6501). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App as Forge } from "../src/app.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";
import { seedAdmin } from "./helpers/admin.ts";

quietLogs();

let dir: string;
let forge: Forge;
let alice: User;
let bob: User;
const old = new Date(Date.now() - 3 * 86_400_000).toISOString();

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-alarms-"));
  forge = createApp({ dataDir: dir, port: 0 });
  const a = await seedAdmin(forge, { username: "alice", email: "a@forge.test", password: "a-long-passphrase" });
  if (!a.ok) throw new Error("signup failed");
  alice = a.value;
  const b = await createUser(forge.db, {
    origin: "seed",
    trusted: true,
    username: "bob",
    email: "b@forge.test",
    password: "a-long-passphrase",
  });
  if (!b.ok) throw new Error(b.error);
  bob = b.value;
});

afterAll(async () => {
  forge.close();
  await rm(dir, { recursive: true, force: true });
});

async function firstScreen(user: User): Promise<string> {
  const terminal = headlessTerminal(200, 32);
  const { app } = createForgeApp(
    forge,
    { sshUsername: user.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:t", user },
    { terminal, exitHooks: false },
  );
  app.start();
  await settleApp(app);
  const text = app.screen.toText();
  app.stop();
  return text;
}

/** An approved open pull in a new autonomous repository whose only event was three days ago. */
function stuckPull(name: string, visibility: "public" | "private"): void {
  const db = forge.db;
  db.run("INSERT INTO repo (id, owner_id, name, visibility, autonomy) VALUES (?1, ?2, ?1, ?3, 'auto')", [name, alice.id, visibility]);
  db.run("INSERT INTO issue (id, repo_id, number, kind, title, author_id, state, created_at) VALUES (?1, ?1, 1, 'pull', 't', ?2, 'open', ?3)", [name, alice.id, old]);
  db.run("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid) VALUES (?1, 'main', 'b', '', 'h')", [name]);
  db.run("INSERT INTO review (id, issue_id, author_id, state, commit_oid, created_at) VALUES (?1, ?1, ?2, 'approved', 'h', ?3)", [name, alice.id, old]);
  db.run("INSERT INTO run (id, repo_id, kind, issue_id, state, commit_oid, created_at, finished_at) VALUES (?1, ?1, 'check', ?1, 'failed', 'h', ?2, ?2)", [name, old]);
}

test("a quiet database draws no alarm line", async () => {
  expect(await firstScreen(alice)).not.toContain("has sat approved");
});

test("a stuck approved pull draws the stuck line for an admin; a non-admin reads public ones alone", async () => {
  stuckPull("secret", "private");
  expect(await firstScreen(alice)).toContain("alice/secret#1 has sat approved");
  expect(await firstScreen(bob)).not.toContain("secret#1");
  stuckPull("open", "public");
  expect(await firstScreen(bob)).toContain("alice/open#1 has sat approved");
});

test("a cleared clog's note is on the admin's home line and nobody else's", async () => {
  forge.db.run(
    "INSERT INTO event (id, kind, repo_id, actor_id, payload, created_at) VALUES ('clog1', 'clog.cleared', NULL, NULL, ?1, ?2)",
    [JSON.stringify({ note: "Clog cleared. Cause: the pile.\n\n- Time to clear: 3 min\n" }), new Date().toISOString()],
  );
  expect(await firstScreen(alice)).toContain("Clog cleared. Cause: the pile.");
  expect(await firstScreen(bob)).not.toContain("Clog cleared");
});

test("the dashboard's since-you-were-here shows a release and a failed gate", async () => {
  const db = forge.db;
  const now = new Date().toISOString();
  db.run("INSERT INTO repo (id, owner_id, name, visibility) VALUES ('shipped', ?1, 'shipped', 'public')", [alice.id]);
  db.run("INSERT INTO release (sha, repo_id, pull_number, ok, line, created_at) VALUES ('abc1234', 'shipped', 1, 1, 'ok', ?1)", [now]);
  db.run("INSERT INTO gate_result (id, repo_id, run_id, tip_oid, state, started_at, finished_at) VALUES ('g1', 'shipped', 'r', 't', 'red', ?1, ?1)", [now]);
  const text = await firstScreen(bob);
  expect(text).toContain("alice/shipped");
  expect(text).toContain("1 released");
  expect(text).toContain("1 failed");
});
