/** The lane has stopped (#11507): ten open pulls, 91 minutes without a merge and one repeated failure line raise exactly one alarm; a merge clears it. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo, getRepo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { getRun } from "../src/core/runs.ts";
import { ownLandingStopped } from "../src/checks/gate_stopped.ts";
import { hunt } from "../src/crew/sentinel.ts";
import { firedAlarms } from "../src/flow/alarms.ts";
import { forgeFailed, laneAlarm, laneMinutes, maskLine } from "../src/flow/alarm_lane.ts";
import { id } from "../src/kernel/id.ts";

const NOW = new Date("2026-11-12T17:11:00.000Z");
const ago = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const LINE = "stopped: used 16.0 cores for 30s, over its limit of 16";

let root: string;
let app: App;
let repoId: string;
let userId: string;
let n = 0;
const saved = { sentinel: process.env["FORGE_SENTINEL_REPO"], commit: process.env["FORGE_COMMIT"] };

beforeAll(async () => {
  process.env["FORGE_SENTINEL_REPO"] = "trevato/forge";
  process.env["FORGE_COMMIT"] = "abcdef1234567890abcdef1234567890abcdef12";
  root = mkdtempSync(join(tmpdir(), "forge-lane-"));
  app = createApp({ dataDir: root, port: 0 });
  const u = await createUser(app.db, { username: "trevato", email: "t@forge.test", password: "a-good-passphrase", origin: "seed", trusted: true, adminIfFirst: true });
  if (!u.ok) throw new Error(u.error);
  userId = u.value.id;
  const repo = await createRepo(app.db, app.reposRoot, { ownerId: u.value.id, name: "forge", visibility: "public", description: "f" });
  if (!repo.ok) throw new Error(repo.error);
  repoId = repo.value.id;
});
afterAll(() => {
  app.close();
  rmSync(root, { recursive: true, force: true });
  for (const [k, v] of [["FORGE_SENTINEL_REPO", saved.sentinel], ["FORGE_COMMIT", saved.commit]] as const)
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
});

function pull(state: "open" | "closed", mergedMinAgo?: number): string {
  const issueId = id();
  n++;
  app.db.query(`INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at) VALUES (?1, ?2, ?3, 'pull', 'P', '', ?4, ?5, ?6)`).run(issueId, repoId, 2000 + n, userId, state, ago(600));
  app.db
    .query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id, merged_at, merged_oid) VALUES (?1, 'main', ?2, '', '', ?3, ?4, ?5)`)
    .run(issueId, `b/${n}`, repoId, mergedMinAgo === undefined ? null : ago(mergedMinAgo), mergedMinAgo === undefined ? "" : "9".repeat(40));
  return issueId;
}
function failed(issueId: string, minAgo: number, summary = LINE, detail = "{}"): string {
  const runId = `${String(++n).padStart(4, "0")}${id()}`;
  app.db
    .query(`INSERT INTO run (id, repo_id, issue_id, kind, env, state, summary, check_detail, commit_oid, created_at, finished_at) VALUES (?1, ?2, ?3, 'check', 'pull-1', 'failed', ?4, ?5, 'c', ?6, ?6)`)
    .run(runId, repoId, issueId, summary, detail, ago(minAgo));
  return runId;
}
const reset = () => {
  app.db.query(`DELETE FROM run`).run();
  app.db.query(`DELETE FROM pull`).run();
  app.db.query(`DELETE FROM issue`).run();
};
const lane = () => firedAlarms(app.db, NOW, { dataDir: null }).filter((a) => a.key === "lane_stopped");

/** Ten open pulls and a last merge `since` minutes ago; one failed check apiece after it. */
function stalled(since: number): string[] {
  reset();
  pull("closed", since);
  const pulls = Array.from({ length: 10 }, () => pull("open"));
  pulls.forEach((p, i) => {
    failed(p, 75 + i, LINE.replace("16.0", `1${i}.0`));
  });
  return pulls;
}

describe("the lane has stopped", () => {
  test("ten open pulls, 91 minutes without a merge and one repeated line raise exactly one alarm with that line", () => {
    stalled(91);
    const a = lane();
    expect(a).toHaveLength(1);
    expect(a[0]!.says).toContain("Nothing has merged for 1 h 31 min");
    expect(a[0]!.says).toContain("10 pulls open");
    expect(a[0]!.says).toContain("10 checks failed");
    expect(a[0]!.since).toBe(ago(91));
    // The commonest line, verbatim as the forge holds it (the newest instance of the masked group).
    expect(laneAlarm(app.db, NOW).line).toBe(LINE.replace("16.0", "10.0"));
  });

  test("the line is quoted as recorded, with its count in the span", () => {
    reset();
    pull("closed", 120);
    const p = pull("open");
    for (let i = 0; i < 3; i++) failed(p, 100 - i);
    failed(p, 50, "check failed: install broke");
    const a = laneAlarm(app.db, NOW);
    expect(a.fired).toBe(true);
    expect(a.says).toContain(`4 checks failed in that span, 3 of them with: ${LINE}`);
  });

  test("89 minutes is quiet, and so is a setting that moves the limit", () => {
    stalled(89);
    expect(lane()).toHaveLength(0);
    app.db.query(`INSERT INTO forge_setting (key, value, updated_by, updated_at) VALUES ('flow.lane_minutes', '60', 't', 'now')`).run();
    expect(laneMinutes(app.db)).toBe(60);
    expect(lane()).toHaveLength(1);
    app.db.query(`UPDATE forge_setting SET value = 'abc' WHERE key = 'flow.lane_minutes'`).run();
    expect(laneMinutes(app.db)).toBe(90);
    app.db.query(`DELETE FROM forge_setting WHERE key = 'flow.lane_minutes'`).run();
  });

  test("nothing open or ready, or the crew at its ceiling, is quiet", () => {
    reset();
    pull("closed", 300);
    expect(lane()).toHaveLength(0);
    pull("open");
    expect(firedAlarms(app.db, NOW, { dataDir: null, ceilingUsd: null }).filter((a) => a.key === "lane_stopped")).toHaveLength(1);
    app.db
      .query(`INSERT INTO run (id, repo_id, kind, state, cost_usd, created_at, summary, check_detail) VALUES (?1, ?2, 'agent', 'ok', 50, ?3, '', '')`)
      .run(id(), repoId, new Date(NOW.getTime() - 60_000).toISOString());
    expect(firedAlarms(app.db, NOW, { dataDir: null, ceilingUsd: 20 }).filter((a) => a.key === "lane_stopped")).toHaveLength(0);
  });

  test("a merge clears it", () => {
    stalled(91);
    expect(lane()).toHaveLength(1);
    pull("closed", 1);
    expect(lane()).toHaveLength(0);
  });

  test("it reaches the owner's ask and one Sentinel issue, which closes when a pull merges", () => {
    stalled(91);
    const owner = app.db.query<{ id: string }, []>(`SELECT id FROM user WHERE username = 'trevato'`).get()!;
    expect(owner.id).toBe(userId);
    hunt(app, "trevato/forge", NOW.getTime());
    hunt(app, "trevato/forge", NOW.getTime() + 60_000);
    const open = () => app.db.query<{ body: string }, []>(`SELECT body FROM issue WHERE state = 'open' AND title LIKE 'Sentinel: %lane has stopped%'`).all();
    expect(open()).toHaveLength(1);
    expect(open()[0]!.body).toContain("stopped: used");
    expect(open()[0]!.body).toContain("checks failed since the last merge");
    pull("closed", 1);
    hunt(app, "trevato/forge", NOW.getTime() + 120_000);
    expect(open()).toHaveLength(0);
  });

  test("a sweep reads the forge's lines once: the memo answers the second pull", () => {
    reset();
    pull("closed", 10);
    const runs = Array.from({ length: 5 }, (_, i) => failed(pull("open"), 5 + i, LINE.replace("16.0", `${i + 11}.5`)));
    const memo = new Map<string, ReadonlySet<string>>();
    expect(forgeFailed(app.db, getRun(app.db, runs[0]!), NOW.getTime(), memo)).toBe(true);
    expect(memo.get(repoId)?.size).toBe(1);
    app.db.query(`DELETE FROM run WHERE id != ?1`).run(runs[1]!);
    expect(forgeFailed(app.db, getRun(app.db, runs[1]!), NOW.getTime(), memo)).toBe(true);
    expect(forgeFailed(app.db, getRun(app.db, runs[1]!), NOW.getTime())).toBe(false);
  });

  test("land_past_gate stays shut: a merge drought is not a red gate", () => {
    stalled(91);
    expect(laneAlarm(app.db, NOW).fired).toBe(true);
    const repo = getRepo(app.db, "trevato", "forge")!;
    expect(ownLandingStopped(app.db, repo)).toBeUndefined();
  });
});

describe("one cause failing many pulls", () => {
  test("five pulls in an hour on one masked line are the forge's: alarm names it, the check is the forge's", () => {
    reset();
    pull("closed", 10);
    const pulls = Array.from({ length: 5 }, () => pull("open"));
    const runs = pulls.map((p, i) => failed(p, 5 + i, LINE.replace("16.0", `${i + 11}.5`)));
    const a = lane();
    expect(a).toHaveLength(1);
    expect(a[0]!.says).toContain("the forge's failure, not the builders'");
    expect(a[0]!.says).toContain("5 pulls");
    expect(laneAlarm(app.db, NOW).forge).toBe(true);
    expect(forgeFailed(app.db, getRun(app.db, runs[0]!), NOW.getTime())).toBe(true);
  });

  test("four pulls, or five over two hours, or a named test, are the pull's own", () => {
    reset();
    pull("closed", 10);
    const pulls = Array.from({ length: 5 }, () => pull("open"));
    const runs = pulls.slice(0, 4).map((p, i) => failed(p, 5 + i));
    expect(lane()).toHaveLength(0);
    expect(forgeFailed(app.db, getRun(app.db, runs[0]!), NOW.getTime())).toBe(false);
    failed(pulls[4]!, 130);
    expect(forgeFailed(app.db, getRun(app.db, runs[0]!), NOW.getTime())).toBe(false);
    reset();
    pull("closed", 10);
    const named = Array.from({ length: 5 }, () => pull("open")).map((p, i) => failed(p, 5 + i, "1 test failed", JSON.stringify({ names: ["a > b"] })));
    expect(lane()).toHaveLength(0);
    expect(forgeFailed(app.db, getRun(app.db, named[0]!), NOW.getTime())).toBe(false);
  });

  test("numbers are masked", () => {
    expect(maskLine(LINE)).toBe("stopped: used # cores for #s, over its limit of #");
  });
});
