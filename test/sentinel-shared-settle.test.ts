/**
 * A shared red that ends by itself (#8287): its span closed, no pull failed
 * the test since, and main's newest check, created after the span closed,
 * passes it. The sentinel closes its own issue as dropped before a builder is
 * handed it, on the hourly hunt and on every tick, never one a person has
 * spoken on, never without write access, and files a repeat within the day
 * fresh, quoting the earlier one. One the rule now calls each pull's own
 * (#8786) — main passes it and no re-run did — closes as dropped too, saying
 * so. The tests named "exception" guard what must stay open.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quietLogs } from "./helpers/globals.ts";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { addCrew, createAgentRow } from "../src/core/agents.ts";
import { addComment, createIssue, getIssueById, listComments, listIssues } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import { createRun } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { sharedCause } from "../src/checks/shared_red.ts";
import { hunt, sentinelTick } from "../src/crew/sentinel.ts";

quietLogs();

const TEST = "board > a card keeps its place";
const MIN = 60_000;
const HOUR = 60 * MIN;
const T = Date.parse("2026-10-30T12:00:00.000Z");

let dir: string;
let app: App;
let repo: Repo;
let alice: User;
let sentinelId: string;
const cause = (): string => sharedCause({ repoId: repo.id, test: TEST });
const filed = () =>
  listIssues(app.db, repo.id, { state: "all" }).filter((i) => i.title.startsWith(`Sentinel: ${cause()}`));

/** A check on a pull or on main, finished at `at`; a failed one fails the test. */
function check(state: "ok" | "failed", at: number, issueId?: string): void {
  const run = createRun(app.db, { repoId: repo.id, kind: "check", ...(issueId ? { issueId } : { env: "main" }) });
  app.db
    .query("UPDATE run SET state = ?2, created_at = ?3, finished_at = ?3, commit_oid = ?4, check_detail = ?5 WHERE id = ?1")
    .run(run.id, state, new Date(at).toISOString(), "e".repeat(40), state === "failed" ? JSON.stringify({ names: [TEST] }) : "{}");
}
function redPull(n: number, at: number): void {
  const pull = createIssue(app.db, { repoId: repo.id, authorId: alice.id, title: `pull ${n}`, kind: "pull" });
  if (!pull.ok) throw new Error(String(pull.error));
  check("failed", at, pull.value.id);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-sentinel-settle-"));
  app = createApp({ dataDir: dir, port: 0 });
  const a = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!a.ok) throw new Error(a.error);
  alice = a.value;
  const made = await createRepo(app, alice, { name: "forge", visibility: "private" });
  if (!made.ok) throw new Error(String(made.error));
  repo = made.value;
  const s = await createUser(app.db, { origin: "seed", username: "sentinel", email: "sentinel@a.invalid", agent: true });
  if (!s.ok) throw new Error("agent");
  createAgentRow(app.db, { userId: s.value.id, brief: "hunt", createdBy: alice.id });
  addCrew(app.db, repo.id, s.value.id, alice.id);
  sentinelId = s.value.id;
  // Closing an issue takes write access: here the sentinel is a site admin.
  app.db.query("UPDATE user SET is_admin = 1 WHERE id = ?1").run(sentinelId);
  // A shared red: three pulls fail the test, the span opens, the sentinel files it.
  app.db
    .query("INSERT INTO degraded_span (cause, sentence, href, opened_at) VALUES (?1, 'It is red on 3 pulls.', '/x', ?2)")
    .run(cause(), T - 50 * MIN);
  for (let n = 0; n < 3; n++) redPull(n, T - 45 * MIN + n * MIN);
  expect(hunt(app, "alice/forge", T - 40 * MIN).filed).toBe(1);
  // It ends by itself: the span closes and main's next check is green.
  app.db.query("UPDATE degraded_span SET closed_at = ?1 WHERE cause = ?2").run(T - 20 * MIN, cause());
  check("ok", T - 15 * MIN);
});

/** The check runner re-ran the test alone and it passed: a flake, the lane's red (#8786). */
function flaked(at: number): void {
  app.db
    .query("INSERT INTO check_flake (id, repo_id, run_id, commit_oid, test, file, at) VALUES (?1, ?2, 'r', 'e', ?3, 'b.test.ts', ?4)")
    .run(`flake-${at}`, repo.id, TEST, new Date(at).toISOString());
}
afterEach(async () => {
  app.db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("a shared red that passed again on its own (#8287)", () => {
  // A re-run passed it: the lane's red, not each pull's own (#8786).
  beforeEach(() => flaked(T - 44 * MIN));

  test("closes its own issue as dropped, saying when and why, and files nothing new", () => {
    hunt(app, "alice/forge", T);
    const [issue, ...more] = filed();
    expect(more).toEqual([]);
    expect(issue!.state).toBe("closed");
    expect(issue!.closeReason).toBe("dropped");
    const said = listComments(app.db, issue!.id).filter((c) => c.body.startsWith("Passed again on its own at "));
    expect(said.length).toBe(1);
    expect(said[0]!.body).toContain(`Passed again on its own at ${new Date(T - 20 * MIN).toISOString()}; evidence:`);
    expect(said[0]!.body).toContain("pulls failed it on checks created since: 0");
    expect(said[0]!.body).toContain("main: passes on main's newest check");
    // The day's degraded total does not file it again.
    hunt(app, "alice/forge", T + 2 * HOUR);
    expect(filed().length).toBe(1);
  });

  test("exception: stays open while a pull has failed it since the span closed", () => {
    redPull(9, T - 10 * MIN);
    hunt(app, "alice/forge", T);
    expect(filed()[0]!.state).toBe("open");
  });

  test("exception: an issue a person has commented on is never closed this way", () => {
    addComment(app.db, { issueId: filed()[0]!.id, authorId: alice.id, body: "I am looking at this" });
    hunt(app, "alice/forge", T);
    const [issue] = filed();
    expect(issue!.state).toBe("open");
    expect(listComments(app.db, issue!.id).some((c) => c.body.startsWith("Passed again"))).toBe(false);
  });

  test("stays open when main's newest check was created before the span closed", () => {
    app.db.query("UPDATE run SET created_at = ?1 WHERE env = 'main'").run(new Date(T - 30 * MIN).toISOString());
    hunt(app, "alice/forge", T);
    expect(filed()[0]!.state).toBe("open");
  });

  test("stays open when main's newest check fails the test", () => {
    check("failed", T - 10 * MIN);
    hunt(app, "alice/forge", T);
    expect(filed()[0]!.state).toBe("open");
  });

  test("a tick between hunts closes it, before a builder's next pick", () => {
    const prior = process.env.FORGE_SENTINEL_REPO;
    process.env.FORGE_SENTINEL_REPO = "alice/forge";
    try {
      // 40 minutes since the hunt: no hunt is due, the settle still runs.
      expect(sentinelTick(app, T)).toBeNull();
    } finally {
      if (prior === undefined) delete process.env.FORGE_SENTINEL_REPO;
      else process.env.FORGE_SENTINEL_REPO = prior;
    }
    expect(filed()[0]!.state).toBe("closed");
    expect(filed()[0]!.closeReason).toBe("dropped");
  });

  test("exception: a sentinel without write access closes nothing and says nothing", () => {
    app.db.query("UPDATE user SET is_admin = 0 WHERE id = ?1").run(sentinelId);
    hunt(app, "alice/forge", T);
    const [issue] = filed();
    expect(issue!.state).toBe("open");
    expect(listComments(app.db, issue!.id).some((c) => c.body.startsWith("Passed again"))).toBe(false);
  });

  test("the same cause opening again within a day is a fresh issue quoting the earlier one", () => {
    hunt(app, "alice/forge", T);
    const earlier = filed()[0]!;
    expect(earlier.state).toBe("closed");
    app.db
      .query("INSERT INTO degraded_span (cause, sentence, href, opened_at) VALUES (?1, 'It is red on 3 pulls.', '/x', ?2)")
      .run(cause(), T + 3 * HOUR);
    flaked(T + 3 * HOUR);
    expect(hunt(app, "alice/forge", T + 3 * HOUR + 5 * MIN).filed).toBe(1);
    const fresh = filed().find((i) => i.id !== earlier.id)!;
    expect(fresh.state).toBe("open");
    const body = getIssueById(app.db, fresh.id)!.body;
    expect(body).toContain(`Opened again within a day of #${earlier.number}`);
    expect(body).toContain(`> Passed again on its own at ${new Date(T - 20 * MIN).toISOString()}`);
  });

  test("a repeat more than a day after it settled is filed without the quote", () => {
    hunt(app, "alice/forge", T);
    app.db
      .query("INSERT INTO degraded_span (cause, sentence, href, opened_at) VALUES (?1, 'It is red on 3 pulls.', '/x', ?2)")
      .run(cause(), T + 25 * HOUR);
    flaked(T + 25 * HOUR);
    expect(hunt(app, "alice/forge", T + 25 * HOUR + 5 * MIN).filed).toBe(1);
    const fresh = filed().find((i) => i.state === "open")!;
    expect(getIssueById(app.db, fresh.id)!.body).not.toContain("Opened again within a day");
  });
});

describe("a shared red the rule now calls each pull's own (#8786)", () => {
  const owned = () =>
    listComments(app.db, filed()[0]!.id).filter((c) => c.body.startsWith("Each pull's own red, not the lane's (#8786)"));

  test("closes its open issue as dropped, saying main passes it and no re-run did, and files nothing new", () => {
    hunt(app, "alice/forge", T);
    const [issue, ...more] = filed();
    expect(more).toEqual([]);
    expect(issue!.state).toBe("closed");
    expect(issue!.closeReason).toBe("dropped");
    expect(owned().length).toBe(1);
    expect(owned()[0]!.body).toContain(`- test: ${TEST}`);
    expect(owned()[0]!.body).toContain("- main: passes on main's newest check");
    expect(owned()[0]!.body).toContain(": none");
    // The day's degraded total does not file it again.
    hunt(app, "alice/forge", T + 2 * HOUR);
    expect(filed().length).toBe(1);
  });

  test("closes it while pulls still fail it, and with its span gone from the day, by the cause its evidence names", () => {
    redPull(9, T - 10 * MIN);
    app.db.query("DELETE FROM degraded_span WHERE cause = ?1").run(cause());
    hunt(app, "alice/forge", T);
    expect(filed()[0]!.state).toBe("closed");
    expect(owned().length).toBe(1);
  });

  test("a tick between hunts closes it, before a builder's next pick", () => {
    const prior = process.env.FORGE_SENTINEL_REPO;
    process.env.FORGE_SENTINEL_REPO = "alice/forge";
    try {
      expect(sentinelTick(app, T)).toBeNull();
    } finally {
      if (prior === undefined) delete process.env.FORGE_SENTINEL_REPO;
      else process.env.FORGE_SENTINEL_REPO = prior;
    }
    expect(filed()[0]!.state).toBe("closed");
    expect(owned().length).toBe(1);
  });

  test("exception: a flake recorded while it was red keeps it the lane's: it stays open while pulls fail it", () => {
    flaked(T - 44 * MIN);
    redPull(9, T - 10 * MIN);
    hunt(app, "alice/forge", T);
    expect(filed()[0]!.state).toBe("open");
  });

  test("exception: main's newest check failing the test keeps it the lane's", () => {
    check("failed", T - 10 * MIN);
    hunt(app, "alice/forge", T);
    expect(filed()[0]!.state).toBe("open");
  });

  test("exception: an issue a person has commented on is never closed this way", () => {
    addComment(app.db, { issueId: filed()[0]!.id, authorId: alice.id, body: "I am looking at this" });
    hunt(app, "alice/forge", T);
    expect(filed()[0]!.state).toBe("open");
    expect(owned()).toEqual([]);
  });
});
