/**
 * The terminal's On you says the same count as Home and /review, folds asks
 * older than 30 days into `N stale, archive?`, and `Z` previews before it
 * dismisses anything.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { id } from "../src/kernel/id.ts";
import type { User } from "../src/core/users.ts";
import { reviewSetOf } from "../src/web/studio/review_set.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";
import { seedAdmin } from "./helpers/admin.ts";

quietLogs();

let dir: string;
let forge: Forge;
let alice: User;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-stale-"));
  forge = createApp({ dataDir: dir, port: 0 });
  const a = await seedAdmin(forge, { username: "alice", email: "a@forge.test", password: "a-long-passphrase" });
  if (!a.ok) throw new Error("signup failed");
  alice = a.value;
  const repo = await createRepo(forge, alice, { name: "wait", visibility: "public" });
  if (!repo.ok) throw new Error("repo failed");
  [30, 40, 24 * 40, 24 * 120].forEach((h, i) => {
    const issueId = id();
    const number = forge.db.query<{ issue_seq: number }, [string]>("UPDATE repo SET issue_seq = issue_seq + 1 WHERE id = ?1 RETURNING issue_seq").get(repo.value.id)!.issue_seq;
    forge.db
      .query(`INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at) VALUES (?1, ?2, ?3, 'pull', ?4, '', ?5, 'open', ?6)`)
      .run(issueId, repo.value.id, number, `Ask ${i}`, alice.id, new Date(Date.now() - h * 3_600_000).toISOString());
    forge.db
      .query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id) VALUES (?1, 'main', ?2, ?3, ?3, ?4)`)
      .run(issueId, `b/${i}`, "0".repeat(40), repo.value.id);
  });
});

afterAll(async () => {
  forge.close();
  await rm(dir, { recursive: true, force: true });
});

test("the card counts what Home counts, folds the stale, and Z archives after a look", async () => {
  const terminal = headlessTerminal(200, 32);
  const { app } = createForgeApp(
    forge,
    { sshUsername: "alice", remoteAddress: "127.0.0.1", fingerprint: "SHA256:t", user: alice },
    { terminal, exitHooks: false },
  );
  app.start();
  const press = async (...keys: string[]) => {
    for (const key of keys) {
      app.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
      await settleApp(app);
    }
  };
  await settleApp(app);
  await press("tab");
  const set = reviewSetOf(forge.db, alice, new Date());
  expect([set.count, set.stale.length]).toEqual([2, 2]);
  expect(app.screen.toText()).toContain(`${set.count} waiting on you`);
  expect(app.screen.toText()).toContain("2 stale, archive?");
  await press("Z");
  expect(app.screen.toText()).toContain("Archive 2 stale asks?");
  expect(reviewSetOf(forge.db, alice, new Date()).stale.length).toBe(2);
  await press("enter");
  const after = reviewSetOf(forge.db, alice, new Date());
  expect([after.count, after.stale.length]).toEqual([2, 0]);
  expect(app.screen.toText()).not.toContain("stale, archive?");
  app.stop();
});
