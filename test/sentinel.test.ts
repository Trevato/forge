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
import { addComment, createIssue, createLabel, labelsFor, listComments, listIssues } from "../src/core/issues.ts";
import { addCrew, createAgentRow } from "../src/core/agents.ts";
import { listEvents } from "../src/core/events.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createRun } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { recordCap } from "../src/crew/guard.ts";
import { sharedCause } from "../src/checks/shared_red.ts";
import { bugClockAlarm, HIGH_BUG_MS, openBugs } from "../src/flow/bugs.ts";
import {
  budgetBreaches,
  degradedCauses,
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
const DAY = 24 * HOUR;

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
  // The error ledger is the process's: a file run before this one in the same shard leaves its lines there.
  clearErrors();
  dataDir = await mkdtemp(join(tmpdir(), "forge-sentinel-"));
  app = createApp({ dataDir, port: 0 });
  const a = await createUser(app.db, {
    origin: "seed",
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
const keptSentinelRepo = process.env.FORGE_SENTINEL_REPO;
afterAll(async () => {
  if (keptSentinelRepo === undefined) delete process.env.FORGE_SENTINEL_REPO;
  else process.env.FORGE_SENTINEL_REPO = keptSentinelRepo;
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

describe("a decline is not a failed push", () => {
  test("runs that say 'pushed nothing' file no push fault", async () => {
    const made = await createRepo(app, alice, { name: "quiet", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    for (let n = 0; n < 5; n++) {
      const run = createRun(app.db, { repoId: made.value.id, kind: "agent" });
      app.db
        .query("UPDATE run SET state = 'failed', summary = ?2, created_at = ?3 WHERE id = ?1")
        .run(run.id, "declined: I made no changes and pushed nothing.", ago((30 + n) * HOUR));
    }
    const keys = findFaults(app.db, NOW).map((f) => f.key);
    expect(keys).not.toContain(`push:${made.value.id}`);
  });
});

describe("a decline that does not lead the summary", () => {
  test("is still not a failed push", async () => {
    const made = await createRepo(app, alice, { name: "quiet2", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    for (let n = 0; n < 5; n++) {
      const run = createRun(app.db, { repoId: made.value.id, kind: "agent" });
      app.db
        .query("UPDATE run SET state = 'failed', summary = ?2, created_at = ?3 WHERE id = ?1")
        .run(run.id, "claude: declined: no feedback, so nothing to do.", ago((30 + n) * HOUR));
    }
    const keys = findFaults(app.db, NOW).map((f) => f.key);
    expect(keys).not.toContain(`push:${made.value.id}`);
  });
});

describe("a dropped connection is not a failed push", () => {
  test("runs that ended on EAI_AGAIN file no push fault", async () => {
    const made = await createRepo(app, alice, { name: "offline", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    for (let n = 0; n < 5; n++) {
      const run = createRun(app.db, { repoId: made.value.id, kind: "agent" });
      app.db
        .query("UPDATE run SET state = 'failed', summary = ?2, created_at = ?3 WHERE id = ?1")
        .run(
          run.id,
          "no changes pushed: API Error: Can't reach the API server — check your internet or DNS (EAI_AGAIN) (api_error)",
          ago((30 + n) * HOUR),
        );
    }
    const keys = findFaults(app.db, NOW).map((f) => f.key);
    expect(keys).not.toContain(`push:${made.value.id}`);
  });
});

describe("a push blocked on the network is still a push fault", () => {
  test("push failed with ECONNREFUSED or unable to connect raises it", async () => {
    const made = await createRepo(app, alice, { name: "walled", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    const lines = [
      "push failed: unable to connect to forge",
      "push failed: ECONNREFUSED",
      "push failed: unable to connect to forge",
      "push failed: ECONNREFUSED",
      "push failed: unable to connect to forge",
    ];
    lines.forEach((line, n) => {
      const run = createRun(app.db, { repoId: made.value.id, kind: "agent" });
      app.db
        .query("UPDATE run SET state = 'failed', summary = ?2, created_at = ?3 WHERE id = ?1")
        .run(run.id, line, ago((30 + n) * HOUR));
    });
    const keys = findFaults(app.db, NOW).map((f) => f.key);
    expect(keys).toContain(`push:${made.value.id}`);
    // Later suites count the day's faults; leave none of this one behind.
    app.db.query("DELETE FROM run WHERE repo_id = ?1").run(made.value.id);
  });
});

describe("a gate never green", () => {
  const gateKeys = (): string[] =>
    findFaults(app.db, NOW).map((f) => f.key).filter((k) => k.startsWith("gate:"));
  const plant = (repoId: string): void => {
    for (let n = 0; n < 15; n++) {
      const run = createRun(app.db, { repoId, kind: "check" });
      app.db
        .query("UPDATE run SET state = 'failed', summary = 'no check.run', created_at = ?2 WHERE id = ?1")
        .run(run.id, ago((40 + n) * HOUR));
    }
  };

  test("in another repository files nothing", async () => {
    const made = await createRepo(app, alice, { name: "elsewhere", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    process.env.FORGE_SENTINEL_REPO = "alice/forge";
    try {
      plant(made.value.id);
      expect(gateKeys()).not.toContain(`gate:${made.value.id}`);
    } finally {
      app.db.query("DELETE FROM run WHERE repo_id = ?1").run(made.value.id);
    }
  });

  test("in the sentinel's own repository still files", () => {
    process.env.FORGE_SENTINEL_REPO = "alice/forge";
    try {
      plant(repo.id);
      expect(gateKeys()).toContain(`gate:${repo.id}`);
    } finally {
      app.db.query("DELETE FROM run WHERE repo_id = ?1 AND summary = 'no check.run'").run(repo.id);
    }
  });
});

describe("a failed push that pushed nothing", () => {
  test("still raises the push fault", async () => {
    const made = await createRepo(app, alice, { name: "blocked", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    for (let n = 0; n < 5; n++) {
      const run = createRun(app.db, { repoId: made.value.id, kind: "agent" });
      app.db
        .query("UPDATE run SET state = 'failed', summary = ?2, created_at = ?3 WHERE id = ?1")
        .run(run.id, "push failed: operation not permitted. Pushed nothing.", ago((30 + n) * HOUR));
    }
    const keys = findFaults(app.db, NOW).map((f) => f.key);
    app.db.query("DELETE FROM run WHERE repo_id = ?1").run(made.value.id);
    expect(keys).toContain(`push:${made.value.id}`);
  });
});

describe("the faults of the day", () => {
  let queuedId = "";
  beforeAll(() => {
    process.env.FORGE_SENTINEL_REPO = "alice/forge";
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
    // 4. a setting away from its default for a week: a line on the capacity page, no finding (#3269).
    setCapacity(app.db, "checks.concurrency", "4", alice.id);
    app.db
      .query("UPDATE forge_setting SET updated_at = ?1 WHERE key = 'checks.concurrency'")
      .run(ago(8 * 24 * HOUR));
    // 5. a hand-installed guard that outlived its fix.
    app.db.exec(
      `CREATE TRIGGER steward_guard_repo BEFORE INSERT ON repo
       BEGIN SELECT RAISE(ABORT, 'forge: paused for new accounts'); END`,
    );
  });

  test("each is named with its evidence", () => {
    const keys = findFaults(app.db, NOW).map((f) => f.key).sort();
    expect(keys).toEqual(
      [
        `gate:${repo.id}`,
        `push:${repo.id}`,
        "slot:check",
        "trigger:steward_guard_repo",
      ].sort(),
    );
    const byKey = new Map(findFaults(app.db, NOW).map((f) => [f.key, f]));
    expect(byKey.get("slot:check")!.evidence.join("\n")).toContain("running: 0");
    expect(byKey.get(`gate:${repo.id}`)!.evidence.join("\n")).toContain(
      "nested cell: no network namespace",
    );
    expect(byKey.has("setting:checks.concurrency")).toBe(false);
    expect(byKey.get("trigger:steward_guard_repo")!.evidence.join("\n")).toContain(
      "paused for new accounts",
    );
  });

  test("a hunt files each once, and a second hunt files nothing", () => {
    const first = hunt(app, "alice/forge", NOW);
    expect(first.filed).toBe(4);
    const open = () => listIssues(app.db, repo.id, { state: "open", limit: 200 });
    expect(open().length).toBe(4);
    const slot = open().find((i) => i.title.includes("wait with no slot"))!;
    expect(slot.body).toContain("**Evidence**");
    expect(slot.body).toContain("**What to look for when fixed:**");
    expect(slot.body).toContain("**Pillar:**");

    const second = hunt(app, "alice/forge", NOW + 30 * 60_000);
    expect(second).toMatchObject({ found: 4, filed: 0, commented: 0 });
    expect(open().length).toBe(4);
    expect(sentinelStanding(app.db).openFindings).toBe(4);
    expect(sentinelLine(app.db)).toBe("The sentinel has 4 open findings");
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
    const kept = process.env.FORGE_SENTINEL_REPO;
    delete process.env.FORGE_SENTINEL_REPO;
    try {
      expect(sentinelTick(app, last + 5 * 60_000)).toBeNull();
      expect(sentinelTick(app, last + 20 * 60_000)).toBeNull();
      process.env.FORGE_SENTINEL_REPO = "alice/forge";
      expect(sentinelTick(app, last + HOUR + 1)).not.toBeNull();
    } finally {
      if (kept === undefined) delete process.env.FORGE_SENTINEL_REPO;
      else process.env.FORGE_SENTINEL_REPO = kept;
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

  test("a skip is a run saved, not a park: skips alone are never named", () => {
    app.db.query("DELETE FROM decision WHERE kind = 'guard'").run();
    const guard = (answer: string) =>
      recordDecision(app.db, {
        kind: "guard",
        repoId: repo.id,
        state: { reason: "feedback" },
        answer,
        p: 1,
        by: "rule",
        ms: 0,
      });
    const parks = () => findFaults(app.db, Date.now()).find((x) => x.key === `parks:${repo.id}`);
    for (let n = 0; n < 30; n++) guard("skipped");
    for (let n = 0; n < 19; n++) guard("capped");
    expect(parks()).toBeUndefined();
    guard("capped");
    expect(parks()?.title).toContain("parked 20 runs");
    expect(parks()?.evidence.join("\n")).toContain("30 skips");
  });
});

describe("a cap", () => {
  const issueOf = (n: number) => {
    const r = createIssue(app.db, { repoId: repo.id, authorId: alice.id, title: `capped ${n}` });
    if (!r.ok) throw new Error("issue");
    return r.value;
  };

  test("is recorded once per issue per window, however often it is asked", () => {
    app.db.query("DELETE FROM decision WHERE kind = 'guard'").run();
    const issue = issueOf(0);
    expect(recordCap(app.db, repo, issue, 6)).toBe(true);
    expect(recordCap(app.db, repo, issue, 6)).toBe(false);
    const n = () =>
      app.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM decision WHERE kind = 'guard' AND answer = 'capped'").get()?.n;
    expect(n()).toBe(1);
    // A later window is a new park.
    expect(recordCap(app.db, repo, issue, 6, new Date(Date.now() + 2 * DAY))).toBe(true);
    expect(n()).toBe(2);
  });

  test("the parks signal counts distinct issues and names up to five", () => {
    app.db.query("DELETE FROM decision WHERE kind = 'guard'").run();
    const issues = Array.from({ length: 20 }, (_, i) => issueOf(i + 1));
    for (const i of issues) {
      recordCap(app.db, repo, i, 6);
      // A second decision for the same issue, as an old clock wrote them.
      recordDecision(app.db, { kind: "guard", repoId: repo.id, issueId: i.id, state: {}, answer: "capped", p: 1, by: "rule", ms: 0 });
    }
    const parks = findFaults(app.db, Date.now()).find((x) => x.key === `parks:${repo.id}`);
    expect(parks?.title).toContain("parked 20 runs");
    const line = parks?.evidence.find((e) => e.startsWith("capped issues:")) ?? "";
    expect(line.split(",").length).toBe(5);
    expect(line).toContain(`#${issues[0]!.number}`);
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

  test("a setting away from its default brings no hunt and files nothing (#3269)", () => {
    setCapacity(app.db, "cells.egress", "report", alice.id);
    app.db
      .query("UPDATE forge_setting SET updated_at = ?1 WHERE key = 'cells.egress'")
      .run(ago(10 * 24 * HOUR));
    const l = lastHunt();
    expect(withRepo(() => sentinelTick(app, l + 20 * 60_000))).toBeNull();
    hunt(app, "alice/forge", l + 2 * HOUR);
    expect(app.db.query("SELECT COUNT(*) AS n FROM sentinel_finding WHERE key LIKE 'setting:%'").get()).toEqual({ n: 0 });
    expect(app.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM issue WHERE title LIKE 'Sentinel: Setting %'").get()!.n).toBe(0);
    setCapacity(app.db, "cells.egress", "enforce", alice.id);
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

// ---- degraded causes (#1297) ----

let dapp: App;
let drepo: Repo;
const D_MIN = 60_000;
const D_NIGHT = Date.parse("2026-10-13T03:00:00.000Z");
const D_DAY = 24 * 60 * D_MIN;

function plantSpan(cause: string, openedAt: number, minutes: number): void {
  dapp.db
    .query(
      "INSERT INTO degraded_span (cause, sentence, href, opened_at, closed_at) VALUES (?1, ?2, '/admin/queue', ?3, ?4)",
    )
    .run(cause, `The ${cause} is backed up.`, openedAt, openedAt + minutes * D_MIN);
}
const openIssues = () => listIssues(dapp.db, drepo.id, { state: "open" } as never);


describe("degraded causes", () => {
  let ddir: string;
  beforeAll(async () => {
    ddir = await mkdtemp(join(tmpdir(), "forge-sentinel-degraded-"));
    dapp = createApp({ dataDir: ddir, port: 0 });
    const a = await createUser(dapp.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    const made = await createRepo(dapp, a.value, { name: "forge", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    drepo = made.value;
  });
  afterAll(async () => {
    dapp.db.close();
    await rm(ddir, { recursive: true, force: true });
  });

  test("a 4-minute span files nothing", () => {
    plantSpan("short", D_NIGHT - 2 * 3_600_000, 4);
    expect(degradedCauses(dapp.db, D_NIGHT)).toEqual([]);
    expect(hunt(dapp, "alice/forge", D_NIGHT).filed).toBe(0);
  });

  test("a 25-minute span files one issue; the next night comments on it", () => {
    plantSpan("queue", D_NIGHT - 2 * 3_600_000, 25);
    const found = degradedCauses(dapp.db, D_NIGHT);
    expect(found.map((f) => f.key)).toEqual(["degraded:queue"]);
    const text = found[0]!.evidence.join("\n");
    expect(text).toContain("The queue is backed up.");
    expect(text).toContain("25 minutes");
    expect(text).toContain("/admin/queue");
    expect(found[0]!.pillar).toStartWith("P0 Trust");

    expect(hunt(dapp, "alice/forge", D_NIGHT).filed).toBe(1);
    expect(hunt(dapp, "alice/forge", D_NIGHT + 30 * D_MIN).filed).toBe(0);
    expect(openIssues().length).toBe(1);

    plantSpan("queue", D_NIGHT + D_DAY - 2 * 3_600_000, 25);
    const next = hunt(dapp, "alice/forge", D_NIGHT + D_DAY);
    expect(next.filed).toBe(0);
    expect(next.commented).toBe(1);
    const open = openIssues();
    expect(open.length).toBe(1);
    expect(listComments(dapp.db, open[0]!.id).length).toBe(1);
  });

  test("spans that add up past ten minutes are one finding", () => {
    const day = D_NIGHT + 3 * D_DAY;
    plantSpan("disk", day - 5 * 3_600_000, 6);
    plantSpan("disk", day - 3 * 3_600_000, 6);
    expect(degradedCauses(dapp.db, day).map((f) => f.key)).toEqual(["degraded:disk"]);
  });

  test("a drill cause is a person's: no issue, but a shared one of the forge's own still is", () => {
    const day = D_NIGHT + 10 * D_DAY;
    plantSpan("drill:never", day - 5 * 3_600_000, 30);
    plantSpan("drill:compute", day - 3 * 3_600_000, 30);
    expect(degradedCauses(dapp.db, day, drepo.id)).toEqual([]);
    expect(degradedCauses(dapp.db, day)).toEqual([]);
    plantSpan(`shared:${drepo.id}:abc`, day - 2 * 3_600_000, 30);
    expect(degradedCauses(dapp.db, day, drepo.id).map((f) => f.key).length).toBe(1);
  });
});

// ---- budget breaches (#1270) ----

describe("a budget breach is crew work at once", () => {
  let bapp: App;
  let brepo: Repo;
  let bdir: string;
  let sentinelId = "";
  beforeAll(async () => {
    bdir = await mkdtemp(join(tmpdir(), "forge-sentinel-breach-"));
    bapp = createApp({ dataDir: bdir, port: 0 });
    const a = await createUser(bapp.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    const made = await createRepo(bapp, a.value, { name: "forge", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    brepo = made.value;
    const s = await createUser(bapp.db, {
      origin: "seed",
      username: "sentinel",
      email: "sentinel@a.invalid",
      agent: true,
    });
    if (!s.ok) throw new Error("agent");
    sentinelId = s.value.id;
    createAgentRow(bapp.db, { userId: sentinelId, brief: "hunt", createdBy: a.value.id });
    addCrew(bapp.db, brepo.id, sentinelId, a.value.id);
    createLabel(bapp.db, brepo.id, "P0 Trust", "b4533a");
  });
  afterAll(async () => {
    bapp.db.close();
    await rm(bdir, { recursive: true, force: true });
  });

  test("an open lane breach is filed once, labelled, and left unassigned for a builder", () => {
    bapp.db
      .query(
        "INSERT INTO degraded_span (cause, sentence, href, opened_at) VALUES ('queue:check', '22 checks wait behind one lane; the oldest since 04:13; the lane runs #1212 for 31 min (limit 60).', '/settings/capacity', ?1)",
      )
      .run(NOW - 2 * 60_000);
    const found = budgetBreaches(bapp.db, NOW);
    expect(found.map((f) => f.key)).toEqual(["degraded:queue-check"]);
    expect(found[0]!.evidence.join("\n")).toContain("the lane runs #1212 for 31 min");

    // Two minutes old: a day's total is nowhere near ten minutes, yet it is filed.
    expect(hunt(bapp, "alice/forge", NOW).filed).toBe(1);
    expect(hunt(bapp, "alice/forge", NOW + 60_000).filed).toBe(0);
    expect(hunt(bapp, "alice/forge", NOW + 120_000).filed).toBe(0);
    const open = listIssues(bapp.db, brepo.id, { state: "open" } as never);
    expect(open.length).toBe(1);
    const issue = open[0]!;
    // The sentinel never builds, so it never assigns itself (#3002).
    expect(issue.assigneeId).toBeNull();
    expect(labelsFor(bapp.db, issue.id).map((l) => l.name).sort()).toEqual(["P0 Trust", "bug"]);
    expect(listEvents(bapp.db, { kind: "issue.assigned" }).length).toBe(0);
  });

  test("a red main is filed only for the sentinel's own repository", () => {
    const prior = process.env.FORGE_SENTINEL_REPO;
    process.env.FORGE_SENTINEL_REPO = "alice/forge";
    const ins = bapp.db.query(
      "INSERT INTO degraded_span (cause, sentence, href, opened_at) VALUES (?1, 'main is red', '/x', ?2)",
    );
    try {
      ins.run("red:someotherrepoid", NOW - 60_000);
      expect(budgetBreaches(bapp.db, NOW, brepo.id).some((f) => f.title.startsWith("red:"))).toBe(false);
      ins.run("shared:someotherrepoid:abc", NOW - 60_000);
      expect(budgetBreaches(bapp.db, NOW, brepo.id).some((f) => f.title.startsWith("shared:"))).toBe(false);
      ins.run(`shared:${brepo.id}:abc`, NOW - 60_000);
      expect(budgetBreaches(bapp.db, NOW, brepo.id).filter((f) => f.title.startsWith("shared:")).length).toBe(1);
      ins.run(`red:${brepo.id}`, NOW - 60_000);
      const own = budgetBreaches(bapp.db, NOW, brepo.id).filter((f) => f.title.startsWith("red:"));
      expect(own.length).toBe(1);
      expect(own[0]!.fix).toContain("Fix the failing test on main");
    } finally {
      if (prior === undefined) delete process.env.FORGE_SENTINEL_REPO;
      else process.env.FORGE_SENTINEL_REPO = prior;
      bapp.db.query("DELETE FROM degraded_span WHERE cause LIKE 'red:%' OR cause LIKE 'shared:%'").run();
    }
  });

  test("a breach brings a hunt within a tick, inside the signal gap", () => {
    const t = Date.parse("2026-10-14T12:00:00.000Z");
    hunt(bapp, "alice/forge", t);
    bapp.db
      .query(
        "INSERT INTO degraded_span (cause, sentence, href, opened_at) VALUES ('stuck:run1', 'Run run1 is stuck: no heartbeat for 4 min (limit 3).', '/x', ?1)",
      )
      .run(t);
    const prior = process.env.FORGE_SENTINEL_REPO;
    process.env.FORGE_SENTINEL_REPO = "alice/forge";
    try {
      expect(sentinelTick(bapp, t + 60_000)?.filed).toBe(1);
      expect(sentinelTick(bapp, t + 120_000)).toBeNull();
    } finally {
      if (prior === undefined) delete process.env.FORGE_SENTINEL_REPO;
      else process.env.FORGE_SENTINEL_REPO = prior;
    }
  });
});

// ---- a degraded incident closed as done (#2553) ----

describe("a degraded incident whose issue closed as done", () => {
  let idir: string;
  let iapp: App;
  let irepo: Repo;
  const T0 = Date.parse("2026-10-18T12:00:00.000Z");
  const OPEN = T0 - 3 * HOUR;
  const span = (cause: string, openedAt: number, minutes: number): void => {
    iapp.db
      .query("INSERT INTO degraded_span (cause, sentence, href, opened_at, closed_at) VALUES (?1, 'It is slow.', '/x', ?2, ?3)")
      .run(cause, openedAt, openedAt + minutes * D_MIN);
  };
  const issues = (state: string) => listIssues(iapp.db, irepo.id, { state } as never);
  const close = (reason: string): void => {
    iapp.db.query("UPDATE issue SET state = 'closed', close_reason = ?1, closed_at = ?2").run(reason, new Date(T0).toISOString());
  };
  beforeAll(async () => {
    idir = await mkdtemp(join(tmpdir(), "forge-sentinel-incident-"));
    iapp = createApp({ dataDir: idir, port: 0 });
    const a = await createUser(iapp.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    if (!a.ok) throw new Error(a.error);
    const made = await createRepo(iapp, a.value, { name: "forge", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    irepo = made.value;
  });
  afterAll(async () => {
    iapp.db.close();
    await rm(idir, { recursive: true, force: true });
  });

  test("is commented once a day, not refiled", () => {
    span("drill", OPEN, 40 * 60);
    expect(hunt(iapp, "alice/forge", T0).filed).toBe(1);
    close("done");
    const again = hunt(iapp, "alice/forge", T0 + 30 * D_MIN);
    expect(again.filed).toBe(0);
    expect(again.commented).toBe(1);
    expect(issues("open").length).toBe(0);
    const closed = issues("closed");
    expect(closed.length).toBe(1);
    const comments = listComments(iapp.db, closed[0]!.id);
    expect(comments.length).toBe(1);
    expect(comments[0]!.body).toContain("Still degraded after the fix; the fix may not be live yet");
    // Same day: nothing more, and still no new issue.
    const third = hunt(iapp, "alice/forge", T0 + 2 * HOUR);
    expect(third.filed).toBe(0);
    expect(third.commented).toBe(0);
    expect(listComments(iapp.db, closed[0]!.id).length).toBe(1);
    // The next day it is told again.
    expect(hunt(iapp, "alice/forge", T0 + 25 * HOUR).commented).toBe(1);
    expect(listComments(iapp.db, closed[0]!.id).length).toBe(2);
    expect(issues("open").length).toBe(0);
  });

  test("a new incident of the same cause is refiled", () => {
    const later = T0 + 3 * DAY;
    span("drill", later - HOUR, 30);
    const r = hunt(iapp, "alice/forge", later);
    expect(r.filed).toBe(1);
    expect(issues("open").length).toBe(1);
  });

  test("a finding closed as dropped stays silent while the incident goes on", () => {
    const t = T0 + 10 * DAY;
    span("disk", t - 2 * HOUR, 30);
    expect(hunt(iapp, "alice/forge", t).filed).toBe(1);
    iapp.db.query("UPDATE issue SET state = 'closed', close_reason = 'dropped', closed_at = ?1 WHERE state = 'open'").run(new Date(t).toISOString());
    const r = hunt(iapp, "alice/forge", t + 30 * D_MIN);
    expect(r.filed).toBe(0);
    expect(r.commented).toBe(0);
    expect(issues("open").length).toBe(0);
  });

  test("a finding closed as split is commented once a day, not refiled", () => {
    const t = T0 + 20 * DAY;
    span("queue", t - 2 * HOUR, 30);
    expect(hunt(iapp, "alice/forge", t).filed).toBe(1);
    iapp.db.query("UPDATE issue SET state = 'closed', close_reason = 'split', closed_at = ?1 WHERE state = 'open'").run(new Date(t).toISOString());
    const again = hunt(iapp, "alice/forge", t + 30 * D_MIN);
    expect(again.filed).toBe(0);
    expect(again.commented).toBe(1);
    const third = hunt(iapp, "alice/forge", t + 2 * HOUR);
    expect(third.filed).toBe(0);
    expect(third.commented).toBe(0);
    expect(issues("open").length).toBe(0);
  });

  test("a new incident after a split close is refiled", () => {
    const t = T0 + 30 * DAY;
    span("cache", t - 2 * HOUR, 30);
    expect(hunt(iapp, "alice/forge", t).filed).toBe(1);
    iapp.db.query("UPDATE issue SET state = 'closed', close_reason = 'split', closed_at = ?1 WHERE state = 'open'").run(new Date(t).toISOString());
    // The incident ends; a fresh one opens later, with another first-open time.
    const later = t + 2 * DAY;
    span("cache", later - HOUR, 20);
    const r = hunt(iapp, "alice/forge", later);
    expect(r.filed).toBe(1);
    expect(issues("open").length).toBe(1);
  });

  test("an incident that ended before its issue closed is not refiled as the day slides past its first span (#10291)", () => {
    const t = T0 + 40 * DAY;
    iapp.db.query("UPDATE issue SET state = 'closed', close_reason = 'done', closed_at = ?1 WHERE state = 'open'").run(new Date(t).toISOString());
    // Two spans of one cause: the morning's, and the evening's; both ended.
    span("backup", t - 12 * HOUR, 60);
    span("backup", t - 4 * HOUR, 180);
    expect(hunt(iapp, "alice/forge", t).filed).toBe(1);
    // The fix lands after the evening span ended.
    iapp.db.query("UPDATE issue SET state = 'closed', close_reason = 'done', closed_at = ?1 WHERE state = 'open'").run(new Date(t + HOUR).toISOString());
    // The morning span slides out of the day: the first-open time moves, and the evening's total still counts.
    const r = hunt(iapp, "alice/forge", t + 13 * HOUR);
    expect(r.filed).toBe(0);
    expect(r.commented).toBe(0);
    expect(issues("open").length).toBe(0);
    // A span after the close is a new incident, and is filed.
    span("backup", t + 14 * HOUR, 30);
    expect(hunt(iapp, "alice/forge", t + 15 * HOUR).filed).toBe(1);
  });

  test("one still going on as the day slides past its first span is told to its closed issue, not refiled", () => {
    const t = T0 + 50 * DAY;
    iapp.db.query("UPDATE issue SET state = 'closed', close_reason = 'done', closed_at = ?1 WHERE state = 'open'").run(new Date(t).toISOString());
    span("mirror", t - 12 * HOUR, 60);
    iapp.db
      .query("INSERT INTO degraded_span (cause, sentence, href, opened_at) VALUES ('mirror', 'It is slow.', '/x', ?1)")
      .run(t - 4 * HOUR);
    expect(hunt(iapp, "alice/forge", t).filed).toBe(1);
    iapp.db.query("UPDATE issue SET state = 'closed', close_reason = 'done', closed_at = ?1 WHERE state = 'open'").run(new Date(t + HOUR).toISOString());
    const r = hunt(iapp, "alice/forge", t + 13 * HOUR);
    expect(r.filed).toBe(0);
    expect(r.commented).toBe(1);
    expect(issues("open").length).toBe(0);
  });
});

// ---- a shared test fixed within the hour (#8185) ----

describe("a shared test whose fix landed within the hour", () => {
  let fdir: string;
  let fapp: App;
  let frepo: Repo;
  let author: User;
  const TEST = "MCP backups > a listing that fails";
  const T = Date.parse("2026-10-20T12:00:00.000Z");
  const cause = (): string => sharedCause({ repoId: frepo.id, test: TEST });
  const filedFor = () =>
    listIssues(fapp.db, frepo.id, { state: "all" }).filter((i) => i.title.startsWith(`Sentinel: ${cause()}`));
  /** One pull whose check failed on the test, created at `at`. */
  const red = (n: number, at: number): void => {
    const pull = createIssue(fapp.db, { repoId: frepo.id, authorId: author.id, title: `pull ${n}`, kind: "pull" });
    if (!pull.ok) throw new Error(String(pull.error));
    const run = createRun(fapp.db, { repoId: frepo.id, kind: "check", issueId: pull.value.id });
    fapp.db
      .query("UPDATE run SET state = 'failed', created_at = ?2, finished_at = ?2, check_detail = ?3 WHERE id = ?1")
      .run(run.id, new Date(at).toISOString(), JSON.stringify({ names: [TEST] }));
  };
  beforeAll(async () => {
    fdir = await mkdtemp(join(tmpdir(), "forge-sentinel-fix-"));
    fapp = createApp({ dataDir: fdir, port: 0 });
    const a = await createUser(fapp.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    if (!a.ok) throw new Error(a.error);
    author = a.value;
    const made = await createRepo(fapp, a.value, { name: "forge", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    frepo = made.value;
    fapp.db
      .query("INSERT INTO degraded_span (cause, sentence, href, opened_at) VALUES (?1, 'It is red on 12 pulls.', '/x', ?2)")
      .run(cause(), T - 50 * D_MIN);
    for (let n = 0; n < 12; n++) red(n, T - 40 * D_MIN + n * D_MIN);
    expect(filedFor().length).toBe(0);
    hunt(fapp, "alice/forge", T - 2 * D_MIN);
    expect(filedFor().length).toBe(1);
    // The fix lands a minute before the hunt: its pull closed the issue as done.
    fapp.db
      .query("UPDATE issue SET state = 'closed', close_reason = 'done', closed_at = ?1 WHERE id = ?2")
      .run(new Date(T - D_MIN).toISOString(), filedFor()[0]!.id);
  });
  afterAll(async () => {
    fapp.db.close();
    await rm(fdir, { recursive: true, force: true });
  });

  test("with 12 earlier reds and none since, files no issue and says nothing", () => {
    // Still a breach, as the terminal and the MCP count it.
    expect(budgetBreaches(fapp.db, T, frepo.id).map((f) => f.cause)).toEqual([cause()]);
    const r = hunt(fapp, "alice/forge", T);
    expect(r.commented).toBe(0);
    expect(filedFor().length).toBe(1);
    expect(listComments(fapp.db, filedFor()[0]!.id).length).toBe(0);
    const prior = process.env.FORGE_SENTINEL_REPO;
    process.env.FORGE_SENTINEL_REPO = "alice/forge";
    try {
      // No hunt a tick for the hour it is held.
      expect(sentinelTick(fapp, T + D_MIN)).toBeNull();
    } finally {
      if (prior === undefined) delete process.env.FORGE_SENTINEL_REPO;
      else process.env.FORGE_SENTINEL_REPO = prior;
    }
  });

  test("with 3 reds on checks created after the fix, comments once on the closed issue", () => {
    for (let n = 0; n < 3; n++) red(100 + n, T + n * D_MIN);
    const r = hunt(fapp, "alice/forge", T + 5 * D_MIN);
    expect(r.commented).toBe(1);
    const issues = filedFor();
    expect(issues.length).toBe(1);
    expect(issues[0]!.state).toBe("closed");
    const comments = listComments(fapp.db, issues[0]!.id);
    expect(comments.length).toBe(1);
    expect(comments[0]!.body).toContain("Still red after the fix landed at");
    expect(comments[0]!.body).toContain("3 pulls failed it on checks created since");
    // Told once: the next hunt inside the hour neither comments nor files.
    expect(hunt(fapp, "alice/forge", T + 10 * D_MIN).commented).toBe(0);
    expect(filedFor().length).toBe(1);
    expect(listComments(fapp.db, issues[0]!.id).length).toBe(1);
  });
});

// ---- a finding held for a day is closed as done (#2635) ----

describe("a degraded finding whose cause has stayed closed", () => {
  let hdir: string;
  let happ: App;
  let halice: User;
  const T0 = Date.parse("2026-10-18T12:00:00.000Z");
  const plant = (cause: string, closedAt: number): void => {
    happ.db
      .query("INSERT INTO degraded_span (cause, sentence, href, opened_at, closed_at) VALUES (?1, 'It is slow.', '/x', ?2, ?3)")
      .run(cause, closedAt - 40 * D_MIN, closedAt);
  };
  const state = (title: string): string =>
    happ.db.query<{ state: string }, [string]>("SELECT state FROM issue WHERE title LIKE ?1").get(`%${title}%`)!.state;
  beforeAll(async () => {
    hdir = await mkdtemp(join(tmpdir(), "forge-sentinel-held-"));
    happ = createApp({ dataDir: hdir, port: 0 });
    const a = await createUser(happ.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    if (!a.ok) throw new Error(a.error);
    halice = a.value;
    const made = await createRepo(happ, halice, { name: "forge", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    // Two incidents, both closed at T0; one will get a person's comment.
    plant("drill", T0);
    plant("disk", T0);
    expect(hunt(happ, "alice/forge", T0 + 5 * D_MIN).filed).toBe(2);
  });
  afterAll(async () => {
    happ.db.close();
    await rm(hdir, { recursive: true, force: true });
  });

  test("23 hours closed stays open; a person's comment keeps theirs at 25", () => {
    const disk = happ.db.query<{ id: string }, []>("SELECT id FROM issue WHERE title LIKE '%disk%'").get()!;
    addComment(happ.db, { issueId: disk.id, authorId: halice.id, body: "looking" });

    hunt(happ, "alice/forge", T0 + 23 * HOUR);
    expect(state("drill")).toBe("open");

    hunt(happ, "alice/forge", T0 + 25 * HOUR);
    expect(state("drill")).toBe("closed");
    const drill = happ.db.query<{ id: string; close_reason: string }, []>("SELECT id, close_reason FROM issue WHERE title LIKE '%drill%'").get()!;
    expect(drill.close_reason).toBe("done");
    const said = listComments(happ.db, drill.id).filter((c) => c.body.startsWith("Held since "));
    expect(said.length).toBe(1);
    expect(said[0]!.body).toContain(new Date(T0).toISOString());
    expect(state("disk")).toBe("open");
  });

  test("a finding that comes back is a new issue", () => {
    const t = T0 + 3 * DAY;
    happ.db.query("INSERT INTO degraded_span (cause, sentence, href, opened_at, closed_at) VALUES ('drill', 'It is slow.', '/x', ?1, ?2)").run(t - HOUR, t - 20 * D_MIN);
    expect(hunt(happ, "alice/forge", t).filed).toBe(1);
  });
});

describe("a finding is filed sorted (#8856)", () => {
  let kapp: App;
  let krepo: Repo;
  let kdir: string;
  const names = (issueId: string): string[] => labelsFor(kapp.db, issueId).map((l) => l.name).sort();
  const openTitled = (part: string) =>
    listIssues(kapp.db, krepo.id, { state: "open", limit: 200 }).find((i) => i.title.includes(part));
  beforeAll(async () => {
    kdir = await mkdtemp(join(tmpdir(), "forge-sentinel-kind-"));
    kapp = createApp({ dataDir: kdir, port: 0 });
    const a = await createUser(kapp.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    const made = await createRepo(kapp, a.value, { name: "forge", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    krepo = made.value;
    kapp.db.exec(
      `CREATE TRIGGER planted_guard BEFORE INSERT ON repo
       BEGIN SELECT RAISE(ABORT, 'forge: paused'); END`,
    );
  });
  afterAll(async () => {
    kapp.db.close();
    await rm(kdir, { recursive: true, force: true });
  });

  test("a security finding lands as a high bug, and is past its clock after 4 h", () => {
    const found = findFaults(kapp.db, NOW).find((f) => f.key === "trigger:planted_guard");
    expect(found?.kind).toBe("security");
    expect(hunt(kapp, "alice/forge", NOW).filed).toBe(1);
    const issue = openTitled("planted_guard")!;
    // The repository had no `bug` or `high`: the sentinel made them.
    expect(names(issue.id)).toEqual(["bug", "high"]);
    const filedAt = Date.parse(issue.createdAt);
    expect(bugClockAlarm(kapp.db, new Date(filedAt + HIGH_BUG_MS - 60_000)).fired).toBe(false);
    const alarm = bugClockAlarm(kapp.db, new Date(filedAt + HIGH_BUG_MS + 60_000));
    expect(alarm.fired).toBe(true);
    expect(alarm.href).toBe(`/alice/forge/issues/${issue.number}`);
    expect(alarm.says).toContain("4 h");
  });

  test("still present, it only comments; re-filed after close, it keeps its labels", () => {
    expect(hunt(kapp, "alice/forge", NOW + 60_000).filed).toBe(0);
    const issue = openTitled("planted_guard")!;
    kapp.db.query("UPDATE issue SET state = 'closed' WHERE id = ?1").run(issue.id);
    expect(hunt(kapp, "alice/forge", NOW + 120_000).filed).toBe(1);
    const again = openTitled("planted_guard")!;
    expect(again.id).not.toBe(issue.id);
    expect(names(again.id)).toEqual(["bug", "high"]);
  });

  test("an issue adopted after its record was lost gets its labels", () => {
    const lost = () => [
      { key: "log:lost", title: "The log says lost 3 times", evidence: ["lost"], pillar: "Reliability", lookFor: "No lost.", kind: "defect" as const },
    ];
    expect(hunt(kapp, "alice/forge", NOW, lost).filed).toBe(1);
    const issue = openTitled("log says lost")!;
    // The record is lost and so are the labels: the next hunt adopts the issue, files nothing, and labels it again.
    kapp.db.query("DELETE FROM sentinel_finding WHERE key = 'log:lost'").run();
    kapp.db.query("DELETE FROM issue_label WHERE issue_id = ?1").run(issue.id);
    expect(hunt(kapp, "alice/forge", NOW + 60_000, lost).filed).toBe(0);
    expect(openTitled("log says lost")!.id).toBe(issue.id);
    expect(names(issue.id)).toEqual(["bug"]);
  });

  test("another defect is a bug on the 48 h clock", () => {
    const defect = () => [
      { key: "log:x", title: "The log says x 3 times", evidence: ["x"], pillar: "Reliability", lookFor: "No x.", kind: "defect" as const },
    ];
    expect(hunt(kapp, "alice/forge", NOW, defect).filed).toBe(1);
    expect(names(openTitled("log says x")!.id)).toEqual(["bug"]);
  });

  test("a cosmetic finding lands as polish, on no bug clock (#8969)", () => {
    const cosmetic = () => [
      { key: "look:y", title: "The link y lands on / and is not Home", evidence: ["y"], pillar: "Craft", lookFor: "No y.", kind: "cosmetic" as const },
    ];
    expect(hunt(kapp, "alice/forge", NOW, cosmetic).filed).toBe(1);
    const issue = openTitled("link y lands")!;
    expect(names(issue.id)).toEqual(["polish"]);
    expect(openBugs(kapp.db).some((b) => b.number === issue.number)).toBe(false);
  });

  test("a broken route lands as a high bug (#8969)", () => {
    const broken = () => [
      { key: "route:z", title: "The route /z answers 500", evidence: ["GET /z → 500"], pillar: "Reliability", lookFor: "/z answers.", kind: "broken-route" as const },
    ];
    expect(hunt(kapp, "alice/forge", NOW, broken).filed).toBe(1);
    const issue = openTitled("route /z")!;
    expect(names(issue.id)).toEqual(["bug", "high"]);
    expect(openBugs(kapp.db).find((b) => b.number === issue.number)?.high).toBe(true);
  });
});
