/**
 * The newest agent run of every ready issue is read once for the pass, and
 * `stalled` answers from it as it answers from its own read.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createRun } from "../src/core/runs.ts";
import { createUser } from "../src/core/users.ts";
import { lastAgentRuns, stalled } from "../src/crew/held.ts";
import type { Issue } from "../src/core/issues.ts";

let dir: string;
let app: App;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-stalled-"));
  app = createApp({ dataDir: dir, port: 0 });
});

afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("stalled agrees with its own read for issues never run, queued, left without a pull and with a pull", async () => {
  const u = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  const made = await createRepo(app, u.value, { name: "shop" });
  if (!made.ok) throw new Error(String(made.error));
  const repo = made.value;
  const issues: Issue[] = [];
  for (const title of ["never run", "queued", "declined", "opened a pull", "older declined then pull"]) {
    const o = openIssue(app, u.value, repo, { title });
    if (!o.ok) throw new Error(String(o.error));
    issues.push(o.value);
  }
  const run = (i: Issue, state: string, summary: string, at: string) => {
    const r = createRun(app.db, { repoId: repo.id, kind: "agent", reason: "assigned", issueId: i.id });
    app.db.query("UPDATE run SET state = ?1, summary = ?2, created_at = ?3 WHERE id = ?4").run(state, summary, at, r.id);
  };
  run(issues[1]!, "queued", "", "2026-11-01T00:00:00.000Z");
  run(issues[2]!, "failed", "declined to start", "2026-11-01T00:00:00.000Z");
  run(issues[3]!, "ok", "opened pull #7", "2026-11-01T00:00:00.000Z");
  run(issues[4]!, "failed", "declined", "2026-10-30T00:00:00.000Z");
  run(issues[4]!, "ok", "updated pull #9", "2026-11-02T00:00:00.000Z");
  const last = lastAgentRuns(app, issues.map((i) => i.id));
  expect(last.has(issues[0]!.id)).toBe(false);
  expect(last.get(issues[4]!.id)?.summary).toBe("updated pull #9");
  const answers = issues.map((i) => stalled(app, repo, i));
  expect(issues.map((i) => stalled(app, repo, i, last))).toEqual(answers);
  expect(answers).toEqual([false, true, true, false, false]);
});

test("the batched run cap agrees with capReached, with and without a director's word", async () => {
  const { capReached, capReachedFor, runCapOf } = await import("../src/crew/guard.ts");
  const { addComment } = await import("../src/actions/issues.ts");
  const { getUserByName } = await import("../src/core/users.ts");
  const { listIssues } = await import("../src/core/issues.ts");
  const { getRepo: getRepoByName } = await import("../src/core/repos.ts");
  const alice = getUserByName(app.db, "alice")!;
  const repo = getRepoByName(app.db, "alice", "shop")!;
  const issues = listIssues(app.db, repo.id, { state: "open", kind: "issue" });
  expect(issues.length).toBeGreaterThan(2);
  const now = new Date();
  const mk = (issue: Issue, n: number) => {
    for (let k = 0; k < n; k++) {
      const r = createRun(app.db, { repoId: repo.id, kind: "agent", reason: "assigned", issueId: issue.id });
      app.db.query("UPDATE run SET created_at = ?1 WHERE id = ?2").run(new Date(now.getTime() - 60_000 * (k + 1)).toISOString(), r.id);
    }
  };
  mk(issues[0]!, 12);
  mk(issues[1]!, 12);
  expect(addComment(app, alice, repo, issues[1]!, "go again").ok).toBe(true);
  const caps = (i: Issue) => runCapOf(repo, i, app.config);
  const batch = capReachedFor(app.db, repo, issues, caps, now);
  for (const i of issues) expect(batch.get(i.id)).toBe(capReached(app.db, repo, i, caps(i), now));
  expect(batch.get(issues[0]!.id)).toBe(true);
});
