import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { claimRun, createRun, getRun, listActive } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { requeue, requeueInterrupted } from "../src/crew/dispatch.ts";
import { landedSummary } from "../src/crew/interrupted.ts";
import { STALE_AFTER_MS } from "../src/runs/lease.ts";

describe("a run whose pull landed, then the forge restarts (#12049)", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let bot: User;
  let n = 0;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-landed-restart-"));
    app = createApp({ dataDir, port: 0 });
    const a = await createUser(app.db, {
      origin: "seed", trusted: true, username: "alice",
      email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const made = await createAgent(app, alice, { username: "bot" });
    if (!made.ok) throw new Error(String(made.error));
    bot = made.value.user;
  });

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  /** A running run whose lease lapsed; its pull is merged when `landed`. */
  const setup = async (landed: boolean) => {
    const repo = await createRepo(app, alice, { name: `r${n++}`, visibility: "private" });
    if (!repo.ok) throw new Error(String(repo.error));
    expect(addToCrew(app, alice, repo.value, "bot").ok).toBe(true);
    const issue = openIssue(app, alice, repo.value, { title: "Plant", body: "" });
    if (!issue.ok) throw new Error(String(issue.error));
    const run = createRun(app.db, {
      repoId: repo.value.id, kind: "agent", issueId: issue.value.id, actorId: bot.id, reason: "assigned",
    });
    app.db.query("UPDATE run SET branch = ?2 WHERE id = ?1").run(run.id, `scout/${n}`);
    claimRun(app.db, run.id);
    app.db
      .query("UPDATE run SET heartbeat_at = ?2 WHERE id = ?1")
      .run(run.id, new Date(Date.now() - STALE_AFTER_MS - 1_000).toISOString());
    let number = 0;
    if (landed) {
      const pull = openIssue(app, alice, repo.value, { title: "The pull", body: "" });
      if (!pull.ok) throw new Error(String(pull.error));
      number = pull.value.number;
      app.db.query("UPDATE issue SET kind = 'pull' WHERE id = ?1").run(pull.value.id);
      app.db
        .query(
          `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id, merged_at)
           VALUES (?1, 'main', ?2, 'a', 'b', ?3, ?4)`,
        )
        .run(pull.value.id, `scout/${n}`, repo.value.id, new Date(Date.now() + 1_000).toISOString());
    }
    return { run, number, issueId: issue.value.id };
  };
  const waiting = (issueId: string) => listActive(app.db, "agent").filter((r) => r.issueId === issueId && r.state === "queued");

  test("a lapsed lease after landing reads as done and queues nothing", async () => {
    const { run, number, issueId } = await setup(true);
    requeueInterrupted(app);
    const after = getRun(app.db, run.id)!;
    expect(after.state).toBe("ok");
    expect(after.summary).toBe(landedSummary(number));
    expect(after.summary).toMatch(/^Landed: pull #\d+ is live$/);
    expect(waiting(issueId)).toEqual([]);
  });

  test("a run the restart already recorded interrupted is settled as landed", async () => {
    const { run, number, issueId } = await setup(true);
    app.db
      .query("UPDATE run SET state = 'failed', summary = 'interrupted: restart, resumes on the next pass — cancelled' WHERE id = ?1")
      .run(run.id);
    requeue(app, getRun(app.db, run.id)!, "stopped for a restart; queued again", false);
    expect(getRun(app.db, run.id)!.summary).toBe(landedSummary(number));
    expect(getRun(app.db, run.id)!.state).toBe("ok");
    expect(waiting(issueId)).toEqual([]);
  });

  test("a run really cut mid-work still resumes", async () => {
    const { run, issueId } = await setup(false);
    requeueInterrupted(app);
    expect(getRun(app.db, run.id)!.state).toBe("cancelled");
    expect(waiting(issueId)).toHaveLength(1);
  });
});
