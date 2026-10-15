/**
 * The sentinel (#1131): each of the faults found by hand is planted in a
 * test forge, and the hunt names it once, with its evidence, however many
 * times it hunts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quietLogs } from "./helpers/globals.ts";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { setCapacity } from "../src/core/capacity.ts";
import { clearErrors, createLog } from "../src/kernel/log.ts";
import { recordDecision } from "../src/core/decisions.ts";
import { listComments, listIssues } from "../src/core/issues.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createRun } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import {
  findFaults,
  hunt,
  sentinelLine,
  sentinelNotice,
  sentinelSummary,
  scrub,
  sentinelStanding,
  sentinelTick,
} from "../src/crew/sentinel.ts";

quietLogs();

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
    const stops = () => findFaults(app.db, NOW).find((x) => x.key === `stops:${getRepoById(app.db, repo.id)!.id}`);
    // A genuinely red repository: stopping is the right answer.
    expect(stops()).toBeUndefined();
    const green = plantRun("check", "ok", "ok", new Date(Date.now() + 60_000).toISOString());
    expect(stops()?.evidence[0]).toContain("3 of 3");
    expect(stops()?.evidence.join("\n")).toContain(green);
    app.db.query("DELETE FROM run WHERE id = ?1").run(green);
  });
});

describe("the guard", () => {
  test("twenty parks in a day are named; nineteen are not", () => {
    const park = () =>
      recordDecision(app.db, {
        kind: "guard",
        repoId: repo.id,
        state: {},
        answer: "park",
        p: 1,
        by: "rule",
        ms: 1,
      });
    const parks = () => findFaults(app.db, Date.now()).find((x) => x.key === `parks:${repo.id}`);
    for (let n = 0; n < 19; n++) park();
    expect(parks()).toBeUndefined();
    park();
    expect(parks()?.evidence[0]).toContain("20 `guard` decisions");
  });
});

describe("the log", () => {
  test("the same ERROR line three times is named once, with the line", () => {
    clearErrors();
    const l = createLog("probe");
    for (let n = 1; n <= 3; n++) l.error(`disk write failed after ${n}0 ms`);
    const hits = findFaults(app.db, Date.now()).filter((x) => x.key.startsWith("log:"));
    expect(hits.length).toBe(1);
    expect(hits[0]!.evidence.join("\n")).toContain("3 ERROR lines");
    expect(hits[0]!.evidence.join("\n")).toContain("disk write failed");
    clearErrors();
    const own = createLog("sentinel");
    for (let n = 0; n < 4; n++) own.error("sentinel filing failed");
    expect(findFaults(app.db, Date.now()).some((x) => x.key.startsWith("log:"))).toBe(false);
    clearErrors();
    l.error("once");
    expect(findFaults(app.db, Date.now()).some((x) => x.key.startsWith("log:"))).toBe(false);
  });
});

describe("a hunt with nowhere to file", () => {
  test("is recorded as unfiled, never as finding nothing", () => {
    const stray = "CREATE TRIGGER stray_nowhere AFTER INSERT ON user BEGIN SELECT 1; END";
    app.db.run(stray);
    try {
      const r = hunt(app, "nobody/missing", NOW);
      expect(r.found).toBeGreaterThan(0);
      expect(r.filed).toBe(0);
      expect(r.cannotFile).toBe("nobody/missing not found");
      const prev = process.env["FORGE_SENTINEL_REPO"];
      process.env["FORGE_SENTINEL_REPO"] = "nobody/missing";
      try {
        const line = sentinelSummary(app.db)!;
        expect(line).toContain("The sentinel cannot file: nobody/missing not found");
        expect(line).not.toContain("found nothing");
        expect(sentinelNotice(app.db)?.text).toBe("The sentinel cannot file: nobody/missing not found");
      } finally {
        if (prev === undefined) delete process.env["FORGE_SENTINEL_REPO"];
        else process.env["FORGE_SENTINEL_REPO"] = prev;
      }
    } finally {
      app.db.run("DROP TRIGGER stray_nowhere");
    }
  });
});

describe("what is filed", () => {
  test("a token in a summary or a log line is not quoted", () => {
    const token = "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
    const long = "Zm9yZ2Utc2VjcmV0LWtleS1ub3QtZm9yLWlzc3Vlcy0xMjM0NTY3ODkw";
    for (let n = 0; n < 8; n++)
      plantRun("check", "failed", `deploy failed with token ${token} and ${long}`, ago(n * HOUR));
    const all = findFaults(app.db, NOW)
      .map((f) => `${f.title}\n${f.evidence.join("\n")}`)
      .join("\n");
    expect(all).toContain("deploy failed");
    expect(all).not.toContain(token);
    expect(all).not.toContain(long);
    expect(scrub(`password: ${long}`)).not.toContain(long);
    hunt(app, "alice/forge", NOW + 2 * HOUR);
    for (const i of listIssues(app.db, repo.id, { state: "open", limit: 200 })) {
      expect(i.body).not.toContain(token);
      expect(i.body).not.toContain(long);
    }
  });
});

describe("a comment that cannot be lost", () => {
  test("an issue outside the newest 200 is still commented on, then remembered", () => {
    const gate = listIssues(app.db, repo.id, { state: "open", limit: 200 }).find((i) =>
      i.title.includes("has not been green"),
    )!;
    // Two hundred newer issues push it out of any list window.
    for (let n = 0; n < 205; n++)
      app.db
        .query("INSERT INTO issue (id, repo_id, number, title, body, author_id, state, kind, created_at, updated_at) SELECT ?1, repo_id, ?2, 'filler', '', author_id, 'open', 'issue', ?3, ?3 FROM issue WHERE id = ?4")
        .run(`filler-${n}`, 10_000 + n, new Date(NOW + 3 * HOUR + n).toISOString(), gate.id);
    plantRun("check", "failed", "nested cell: no network namespace", ago(0));
    const before = listComments(app.db, gate.id).length;
    const r = hunt(app, "alice/forge", NOW + 4 * HOUR);
    expect(r.commented).toBeGreaterThan(0);
    expect(listComments(app.db, gate.id).length).toBe(before + 1);
    const stored = app.db
      .query<{ evidence: string }, [string]>("SELECT evidence FROM sentinel_finding WHERE issue_id = ?1")
      .get(gate.id)!;
    expect(stored.evidence).toContain("check runs failed");
  });
});

describe("the signals inside the hour", () => {
  const lastHunt = () => new Date(sentinelStanding(app.db).lastHuntAt!).getTime();
  const withRepo = <T>(fn: () => T): T => {
    process.env.FORGE_SENTINEL_REPO = "alice/forge";
    try {
      return fn();
    } finally {
      delete process.env.FORGE_SENTINEL_REPO;
    }
  };

  test("a new setting away hunts after ten minutes; tracked, it does not", () => {
    setCapacity(app.db, "cells.egress", "report", alice.id);
    app.db
      .query("UPDATE forge_setting SET updated_at = ?1 WHERE key = 'cells.egress'")
      .run(ago(10 * 24 * HOUR));
    const l = lastHunt();
    expect(withRepo(() => sentinelTick(app, l + 5 * 60_000))).toBeNull();
    const r = withRepo(() => sentinelTick(app, l + 20 * 60_000));
    expect(r?.filed).toBe(1);
    expect(withRepo(() => sentinelTick(app, lastHunt() + 20 * 60_000))).toBeNull();
  });

  test("a newly held slot hunts too", () => {
    const run = createRun(app.db, { repoId: repo.id, kind: "deploy" });
    const l = lastHunt();
    app.db
      .query("UPDATE run SET created_at = ?2 WHERE id = ?1")
      .run(run.id, new Date(l - 2 * HOUR).toISOString());
    const r = withRepo(() => sentinelTick(app, l + 20 * 60_000));
    expect(r?.filed).toBe(1);
    expect(withRepo(() => sentinelTick(app, lastHunt() + 20 * 60_000))).toBeNull();
  });
});
