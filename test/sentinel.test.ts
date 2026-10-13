/**
 * The sentinel (#1131): each of the faults found by hand is planted in a
 * test forge, and the hunt names it once, with its evidence, however many
 * times it hunts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { setCapacity } from "../src/core/capacity.ts";
import { recordDecision } from "../src/core/decisions.ts";
import { listComments, listIssues } from "../src/core/issues.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createRun } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import {
  findFaults,
  hunt,
  huntOn,
  sentinelLine,
  sentinelStanding,
  sentinelTick,
} from "../src/crew/sentinel.ts";

let dataDir: string;
let app: App;
let alice: User;
let repo: Repo;
const NOW = Date.parse("2026-10-13T12:00:00.000Z");
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const HOUR = 3_600_000;

function plantRun(
  kind: "check" | "agent",
  state: string,
  summary: string,
  createdAt: string,
): string {
  const run = createRun(app.db, { repoId: repo.id, kind });
  app.db
    .query(
      "UPDATE run SET state = ?2, summary = ?3, created_at = ?4, finished_at = ?4 WHERE id = ?1",
    )
    .run(run.id, state, summary, createdAt);
  return run.id;
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-sentinel-"));
  app = createApp({ dataDir, port: 0 });
  const a = await createUser(app.db, {
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!a.ok) throw new Error(a.error);
  alice = a.value;
  const made = await createRepo(app, alice, { name: "forge", visibility: "private" });
  if (!made.ok) throw new Error(String(made.error));
  repo = made.value;
});
afterAll(async () => {
  app.db.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("a clean forge", () => {
  test("names nothing, and says nothing", () => {
    expect(findFaults(app.db, NOW)).toEqual([]);
    const r = hunt(app, "alice/forge", NOW);
    expect(r).toEqual({ found: 0, filed: 0, commented: 0 });
    expect(sentinelLine(app.db)).toBeNull();
    expect(sentinelStanding(app.db).lastHuntAt).toBe(new Date(NOW).toISOString());
  });
});

describe("the faults of the day", () => {
  let queuedId = "";
  beforeAll(() => {
    // 1. a slot held by a finished run: work waits, nothing runs.
    plantRun("check", "cancelled", "cancelled", ago(3 * HOUR));
    queuedId = createRun(app.db, { repoId: repo.id, kind: "check" }).id;
    app.db.query("UPDATE run SET created_at = ?2 WHERE id = ?1").run(queuedId, ago(2 * HOUR));
    // 2. a gate never green: the same line, run after run.
    for (let n = 0; n < 4; n++)
      plantRun("check", "failed", "nested cell: no network namespace", ago((10 + n) * HOUR));
    // 3. pushes that can only succeed by leaving the sandbox.
    for (let n = 0; n < 3; n++)
      plantRun("agent", "failed", "git push: operation not permitted", ago((20 + n) * HOUR));
    // 4. a setting away from its default for a week.
    setCapacity(app.db, "checks.concurrency", "4", alice.id);
    app.db
      .query("UPDATE forge_setting SET updated_at = ?1 WHERE key = 'checks.concurrency'")
      .run(ago(8 * 24 * HOUR));
    // 5. a hand-installed guard that outlived its fix.
    app.db.exec(
      `CREATE TRIGGER steward_guard_repo BEFORE INSERT ON repo
       BEGIN SELECT RAISE(ABORT, 'paused for new accounts'); END`,
    );
  });

  test("each is named with its evidence", () => {
    const keys = findFaults(app.db, NOW).map((f) => f.key).sort();
    expect(keys).toEqual(
      [
        `gate:${repo.id}`,
        `push:${repo.id}`,
        "setting:checks.concurrency",
        "slot:check",
        "trigger:steward_guard_repo",
      ].sort(),
    );
    const byKey = new Map(findFaults(app.db, NOW).map((f) => [f.key, f]));
    expect(byKey.get("slot:check")!.evidence.join("\n")).toContain("running: 0");
    expect(byKey.get(`gate:${repo.id}`)!.evidence.join("\n")).toContain(
      "nested cell: no network namespace",
    );
    expect(byKey.get("setting:checks.concurrency")!.evidence[0]).toContain('"4", default "1"');
    expect(byKey.get("trigger:steward_guard_repo")!.evidence.join("\n")).toContain(
      "paused for new accounts",
    );
  });

  test("a hunt files each once, and a second hunt files nothing", () => {
    const first = hunt(app, "alice/forge", NOW);
    expect(first.filed).toBe(5);
    const open = () => listIssues(app.db, repo.id, { state: "open", limit: 200 });
    expect(open().length).toBe(5);
    const slot = open().find((i) => i.title.includes("wait with no slot"))!;
    expect(slot.body).toContain("**Evidence**");
    expect(slot.body).toContain("**What to look for when fixed:**");
    expect(slot.body).toContain("**Pillar:**");

    const second = hunt(app, "alice/forge", NOW + 30 * 60_000);
    expect(second).toMatchObject({ found: 5, filed: 0, commented: 0 });
    expect(open().length).toBe(5);
    expect(sentinelStanding(app.db).openFindings).toBe(5);
    expect(sentinelLine(app.db)).toBe("The sentinel has 5 open findings");
  });

  test("a finding whose evidence changed is a comment, not a new issue", () => {
    plantRun("check", "failed", "nested cell: no network namespace", ago(HOUR));
    const r = hunt(app, "alice/forge", NOW + 40 * 60_000);
    expect(r.filed).toBe(0);
    expect(r.commented).toBeGreaterThan(0);
    const gate = listIssues(app.db, repo.id, { state: "open", limit: 200 }).find((i) =>
      i.title.includes("has not been green"),
    )!;
    expect(listComments(app.db, gate.id).some((c) => c.body.includes("Still there"))).toBe(true);
  });

  test("a closed finding that returns is filed again", () => {
    const slot = listIssues(app.db, repo.id, { state: "open", limit: 200 }).find((i) =>
      i.title.includes("wait with no slot"),
    )!;
    app.db.query("UPDATE issue SET state = 'closed' WHERE id = ?1").run(slot.id);
    expect(hunt(app, "alice/forge", NOW + 50 * 60_000).filed).toBe(1);
  });
});

describe("the schedule", () => {
  test("a new fault is a signal inside the hour; a known one waits for the hour", () => {
    const last = new Date(sentinelStanding(app.db).lastHuntAt!).getTime();
    expect(sentinelTick(app, last + 5 * 60_000)).toBeNull();
    expect(sentinelTick(app, last + 20 * 60_000)).toBeNull();
    process.env.FORGE_SENTINEL_REPO = "alice/forge";
    try {
      expect(sentinelTick(app, last + HOUR + 1)).not.toBeNull();
    } finally {
      delete process.env.FORGE_SENTINEL_REPO;
    }
  });

  test("no hunt is on when none runs", () => {
    expect(huntOn()).toBe(false);
  });
});

describe("the ledger", () => {
  test("a week of nothing but stop is named", () => {
    for (let n = 0; n < 3; n++)
      recordDecision(app.db, {
        kind: "retry",
        repoId: repo.id,
        state: { check: "red" },
        answer: "stop",
        p: 1,
        by: "rule",
        ms: 1,
      });
    const f = findFaults(app.db, Date.now()).find((x) => x.key === `stops:${getRepoById(app.db, repo.id)!.id}`);
    expect(f?.evidence[0]).toContain("3 of 3");
  });
});
