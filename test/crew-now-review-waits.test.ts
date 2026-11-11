/**
 * The crew's "waiting for your review" rows (#597) are read for every open
 * agent pull at once (#11119): production's `loopWorstWhat` named
 * GET /api/v1/forge/view in 14 of 20 readings, and its `crewNow` read each
 * pull one at a time, ~11 statements a pull. The row still appears, and the
 * statements one build costs do not grow with the pulls it lists.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crewNow } from "../src/actions/crew_now.ts";
import { createAgent } from "../src/actions/crew.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createApp as createAppRecord } from "../src/core/apps.ts";
import type { Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { getUserByName, type User } from "../src/core/users.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("crewNow's review waits", () => {
  let dataDir = "";
  let app: App;
  let ada: User;
  let repo: Repo;
  let agentId = "";
  let n = 0;

  /** An agent's pull whose check went green two hours ago, with no reviewer on the crew. */
  const greenAgentPull = async () => {
    const branch = `b${++n}`;
    const c = await commitToBranch(app, ada, repo, {
      branch,
      base: "main",
      message: branch,
      files: [{ path: `${branch}.md`, content: "x\n" }],
    });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
    const o = await openPull(app, ada, repo, { title: `pull ${branch}`, body: "", baseBranch: "main", headBranch: branch });
    if (!o.ok) throw new Error(String(o.error));
    app.db.query("UPDATE issue SET author_id = ?2 WHERE id = ?1").run(o.value.id, agentId);
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      issueId: o.value.id,
      env: `pull-${o.value.number}`,
      commitOid: o.value.headOid,
      reason: "pull",
    });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, { state: "ok", summary: "ok" });
    const ago = new Date(Date.now() - 2 * 3_600_000).toISOString();
    app.db.query("UPDATE run SET created_at = ?2, finished_at = ?2 WHERE id = ?1").run(run.id, ago);
    return o.value;
  };

  /** The rows of one build, and the statements it prepared. */
  const build = () => {
    const prepared: string[] = [];
    const original = app.db.query.bind(app.db);
    (app.db as unknown as { query: unknown }).query = (sql: string) => {
      prepared.push(sql);
      return original(sql);
    };
    try {
      return { rows: crewNow({ app }, ada), statements: prepared.length };
    } finally {
      (app.db as unknown as { query: unknown }).query = original;
    }
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "crew-now-waits-"));
    app = createApp({ dataDir, port: 0 });
    const made = await seedAdmin(app, { username: "ada", email: "ada@forge.example" });
    if (!made.ok) throw new Error(made.error);
    ada = made.value;
    const r = await createRepo(app, ada, { name: "garden", visibility: "private" });
    if (!r.ok) throw new Error(String(r.error));
    repo = r.value;
    createAppRecord(app.db, { repoId: repo.id, slug: "garden", access: "private" });
    const seeded = await commitToBranch(app, ada, repo, {
      message: "seed",
      files: [{ path: "README.md", content: "# garden\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const agent = await createAgent(app, ada, { username: "quill" });
    if (!agent.ok) throw new Error(String(agent.error));
    agentId = getUserByName(app.db, "quill")!.id;
  }, 30_000);

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a green agent pull with no reviewer is a row waiting for the owner's review", async () => {
    const pull = await greenAgentPull();
    const { rows } = build();
    const row = rows.find((r) => r.on === `#${pull.number} ${pull.title}`);
    expect(row).toMatchObject({ run: null, app: "ada/garden", who: "you", why: "review", state: "waiting for your review" });
  });

  test("one build's statements are the same for 1 pull as for 9", async () => {
    const one = build();
    for (let i = 0; i < 8; i++) await greenAgentPull();
    const nine = build();
    expect(nine.rows.filter((r) => r.why === "review")).toHaveLength(9);
    expect(nine.statements).toBe(one.statements);
  }, 30_000);
});
