/** Working now lists each visible running run with its minutes; choosing one opens it (#7351). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createIssue } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import { claimRun, createRun } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { workingCommands } from "../src/tui/screens/working.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { proveAll } from "./helpers/verified.ts";

quietLogs();

let dir: string;
let app: App;
let alice: User;
let bob: User;
let repo: Repo;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-working2-"));
  app = createApp({ dataDir: dir, port: 0 });
  const mk = async (username: string, first = false) => {
    const r = await createUser(app.db, {
      origin: "seed", trusted: true, username, email: `${username}@forge.local`,
      password: "a-good-passphrase", adminIfFirst: first,
    });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  alice = await mk("alice", true);
  bob = await mk("bob");
  proveAll(app);
  const made = await createRepo(app, alice, { name: "lobby", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  repo = made.value;
});
afterAll(async () => {
  app.db.close();
  await rm(dir, { recursive: true, force: true });
});

test("one entry per visible running run, with minutes; choosing opens the run", () => {
  const open = createIssue(app.db, { repoId: repo.id, authorId: alice.id, title: "door" });
  const sealed = createIssue(app.db, { repoId: repo.id, authorId: alice.id, title: "hole", sealed: true });
  if (!open.ok || !sealed.ok) throw new Error("issue");
  const shown = createRun(app.db, { repoId: repo.id, kind: "agent", issueId: open.value.id, actorId: alice.id, summary: "sanding" });
  const hidden = createRun(app.db, { repoId: repo.id, kind: "agent", issueId: sealed.value.id, actorId: alice.id, summary: "SEALEDJOB" });
  claimRun(app.db, shown.id);
  claimRun(app.db, hidden.id);
  app.db.run("UPDATE run SET started_at = ? WHERE id = ?", [new Date(Date.now() - 12 * 60_000 - 5000).toISOString(), shown.id]);

  const { app: tui, session } = createForgeApp(
    app,
    { sshUsername: "bob", remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user: bob },
    { terminal: headlessTerminal(120, 40), exitHooks: false },
  );
  const pushed: unknown[] = [];
  const ctx = { ...tui.ctx, push: (screen: unknown) => void pushed.push(screen) } as typeof tui.ctx;
  const cmds = workingCommands(session, ctx, repo);
  expect(cmds).toHaveLength(1);
  expect(cmds[0]!.title).toContain(`Working now: alice on #${open.value.number} sanding · 12 min`);
  expect(cmds[0]!.title).not.toContain("SEALEDJOB");
  cmds[0]!.run();
  expect(pushed).toHaveLength(1);

  expect(workingCommands(session, ctx, undefined)).toEqual([]);
  expect(workingCommands({ ...session, user: undefined } as typeof session, ctx, repo)).toEqual([]);

  // A run with no issue and no actor, under a minute, with a very long summary.
  app.db.run("UPDATE run SET state = 'ok' WHERE id IN (?, ?)", [shown.id, hidden.id]);
  const bare = createRun(app.db, { repoId: repo.id, kind: "agent", summary: "" });
  claimRun(app.db, bare.id);
  const bareCmds = workingCommands(session, ctx, repo);
  expect(bareCmds).toHaveLength(1);
  expect(bareCmds[0]!.title).toContain("Working now: the crew · under a minute");
  app.db.run("UPDATE run SET state = 'ok' WHERE id = ?", [bare.id]);
  const long = createRun(app.db, { repoId: repo.id, kind: "agent", summary: "x".repeat(300) });
  claimRun(app.db, long.id);
  const t = workingCommands(session, ctx, repo)[0]!.title;
  expect(t.endsWith("· under a minute")).toBe(true);
  expect(t.length).toBeLessThan(140);
  pushed.length = 0;
  workingCommands(session, ctx, repo)[0]!.run();
  expect(pushed).toHaveLength(1);
});
