/** The explorer's rank-inputs hash follows pulls, user standing and the front page's weights (#6698). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { setSuspended } from "../src/core/accounts.ts";
import { DEFAULT_WEIGHTS, setFrontWeights } from "../src/core/front.ts";
import { rankInputs } from "../src/core/rank_inputs.ts";
import { createRepo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { id } from "../src/kernel/id.ts";

let root: string;
let app: App;
let ownerId: string;
let repoId: string;
let n = 0;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-rank-inputs-"));
  app = createApp({ dataDir: root, port: 0 });
  const made = await createUser(app.db, { username: "trevato", email: "o@forge.test", password: "a-good-passphrase", origin: "seed", trusted: true, adminIfFirst: true });
  if (!made.ok) throw new Error(made.error);
  ownerId = made.value.id;
  const repo = await createRepo(app.db, app.reposRoot, { ownerId, name: "ranked", visibility: "public", description: "r" });
  if (!repo.ok) throw new Error(repo.error);
  repoId = repo.value.id;
});
afterAll(() => {
  app.db.close();
  rmSync(root, { recursive: true, force: true });
});

function openPull(): string {
  const issue = id();
  app.db
    .query(`INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state) VALUES (?1, ?2, ?3, 'pull', 't', '', ?4, 'open')`)
    .run(issue, repoId, ++n, ownerId);
  app.db
    .query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id) VALUES (?1, 'main', 'b', '', '', ?2)`)
    .run(issue, repoId);
  return issue;
}

test("opening and merging a pull each change the hash", () => {
  const before = rankInputs(app.db);
  const pull = openPull();
  const opened = rankInputs(app.db);
  expect(opened).not.toBe(before);
  app.db.query(`UPDATE pull SET merged_at = '2026-10-26T00:00:00.000Z' WHERE issue_id = ?1`).run(pull);
  app.db.query(`UPDATE issue SET state = 'closed' WHERE id = ?1`).run(pull);
  expect(rankInputs(app.db)).not.toBe(opened);
});

test("closing a pull without merging changes nothing the ranking reads, so the hash is equal", () => {
  const pull = openPull();
  const open = rankInputs(app.db);
  app.db.query(`UPDATE issue SET state = 'closed' WHERE id = ?1`).run(pull);
  expect(rankInputs(app.db)).toBe(open);
});

test("suspending the owner of a ranked repository changes the hash, and restoring them restores it", () => {
  const before = rankInputs(app.db);
  setSuspended(app.db, ownerId, "2026-10-26T00:00:00.000Z");
  expect(rankInputs(app.db)).not.toBe(before);
  setSuspended(app.db, ownerId, null);
  expect(rankInputs(app.db)).toBe(before);
});

test("one front-page weight changes the hash, and setting it back restores it", () => {
  setFrontWeights(app.db, DEFAULT_WEIGHTS, ownerId);
  const first = rankInputs(app.db);
  setFrontWeights(app.db, { ...DEFAULT_WEIGHTS, forks: DEFAULT_WEIGHTS.forks + 1 }, ownerId);
  expect(rankInputs(app.db)).not.toBe(first);
  setFrontWeights(app.db, DEFAULT_WEIGHTS, ownerId);
  expect(rankInputs(app.db)).toBe(first);
});

test("a write the ranking does not read leaves the hash equal", () => {
  const before = rankInputs(app.db);
  createSession(app.db, ownerId); // moves the write clock; ranks nothing
  createSession(app.db, ownerId);
  expect(rankInputs(app.db)).toBe(before);
});
