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
