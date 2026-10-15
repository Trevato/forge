/**
 * Which stage of the one flow an issue is in (`src/flow`): each stage, each
 * stall, a pull closed and re-opened, and the route that serves it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import {
  flowStage,
  STALL_MINUTES,
  type FlowIssue,
  type FlowPull,
} from "../src/flow/stage.ts";

const NOW = new Date("2026-10-15T12:00:00.000Z");
const ago = (minutes: number): string =>
  new Date(NOW.getTime() - minutes * 60_000).toISOString();

const pull = (over: Partial<FlowPull> = {}): FlowPull => ({
  number: 7,
  state: "open",
  openedAt: ago(5),
  closedAt: null,
  mergedAt: null,
  checks: { state: "none", at: null },
  approvals: 0,
  changesRequested: 0,
  requireReview: true,
  reviewedAt: null,
  liveAt: null,
  deployFailed: false,
  ...over,
});

const issue = (over: Partial<FlowIssue> = {}): FlowIssue => ({
  number: 3,
  title: "t",
  createdAt: ago(5),
  assignee: null,
  blockedBy: [],
  pulls: [],
  ...over,
});

const green = { state: "ok", at: ago(4) } as const;

describe("each stage", () => {
  test("issue: nobody on it", () => {
    const s = flowStage(issue(), NOW);
    expect(s).toMatchObject({ stage: "issue", unblock: "assign a builder", pull: null });
    expect(s.since).toBe(ago(5));
  });

  test("issue: assigned, or held by an open blocker", () => {
    expect(flowStage(issue({ assignee: "scout" }), NOW).unblock).toBe("ask scout to open a pull");
    expect(flowStage(issue({ blockedBy: [2] }), NOW).unblock).toBe("finish #2 first");
  });

  test("pull: opened, no check asked for", () => {
    expect(flowStage(issue({ pulls: [pull()] }), NOW)).toMatchObject({
      stage: "pull",
      pull: 7,
      unblock: "run the check on pull #7",
    });
  });

  test("check: running, and failed", () => {
    const running = pull({ checks: { state: "running", at: ago(2) } });
    expect(flowStage(issue({ pulls: [running] }), NOW)).toMatchObject({ stage: "check", since: ago(2) });
    const failed = pull({ checks: { state: "failed", at: ago(2) } });
    expect(flowStage(issue({ pulls: [failed] }), NOW).unblock).toBe("re-run the check on pull #7");
  });

  test("review: green and unreviewed, or changes requested", () => {
    const s = flowStage(issue({ pulls: [pull({ checks: green })] }), NOW);
    expect(s).toMatchObject({ stage: "review", since: ago(4), unblock: "review pull #7" });
    const asked = pull({ checks: green, changesRequested: 1, reviewedAt: ago(1) });
    expect(flowStage(issue({ pulls: [asked] }), NOW)).toMatchObject({
      stage: "review",
      since: ago(1),
      unblock: "address the changes requested on pull #7",
    });
  });

  test("land: approved, or review not required", () => {
    const approved = pull({ checks: green, approvals: 1, reviewedAt: ago(1) });
    expect(flowStage(issue({ pulls: [approved] }), NOW)).toMatchObject({
      stage: "land",
      unblock: "merge pull #7",
      since: ago(1),
    });
    const free = pull({ checks: green, requireReview: false });
    expect(flowStage(issue({ pulls: [free] }), NOW).stage).toBe("land");
  });

  test("land: merged, production not yet serving it", () => {
    const merged = pull({ mergedAt: ago(10) });
    expect(flowStage(issue({ pulls: [merged] }), NOW)).toMatchObject({
      stage: "land",
      since: ago(10),
      unblock: "wait for the production deploy",
    });
    const broken = pull({ mergedAt: ago(10), deployFailed: true });
    expect(flowStage(issue({ pulls: [broken] }), NOW).unblock).toBe("redeploy production");
  });

  test("live: production served the merge", () => {
    const live = pull({ mergedAt: ago(90), liveAt: ago(80) });
    expect(flowStage(issue({ pulls: [live] }), NOW)).toMatchObject({
      stage: "live",
      since: ago(80),
      unblock: "",
      stalled: false,
    });
  });
});

describe("each stall", () => {
  const stalled = (i: FlowIssue) => flowStage(i, NOW).stalled;
  const minutes = STALL_MINUTES;

  test("issue", () => {
    expect(stalled(issue({ createdAt: ago(minutes.issue - 1) }))).toBe(false);
    expect(stalled(issue({ createdAt: ago(minutes.issue + 1) }))).toBe(true);
  });

  test("pull", () => {
    const at = (m: number) => issue({ pulls: [pull({ openedAt: ago(m) })] });
    expect(stalled(at(minutes.pull - 1))).toBe(false);
    expect(stalled(at(minutes.pull + 1))).toBe(true);
  });

  test("check", () => {
    const at = (m: number) =>
      issue({ pulls: [pull({ checks: { state: "running", at: ago(m) } })] });
    expect(stalled(at(minutes.check - 1))).toBe(false);
    expect(stalled(at(minutes.check + 1))).toBe(true);
  });

  test("review", () => {
    const at = (m: number) =>
      issue({ pulls: [pull({ checks: { state: "ok", at: ago(m) } })] });
    expect(stalled(at(minutes.review - 1))).toBe(false);
    expect(stalled(at(minutes.review + 1))).toBe(true);
  });

  test("land", () => {
    const at = (m: number) => issue({ pulls: [pull({ mergedAt: ago(m) })] });
    expect(stalled(at(minutes.land - 1))).toBe(false);
    expect(stalled(at(minutes.land + 1))).toBe(true);
  });

  test("live is never stalled", () => {
    const live = pull({ mergedAt: ago(9000), liveAt: ago(8000) });
    expect(stalled(issue({ pulls: [live] }))).toBe(false);
  });
});

describe("pulls that come and go", () => {
  test("a pull closed unmerged puts the issue back at issue, since the close", () => {
    const closed = pull({ state: "closed", openedAt: ago(100), closedAt: ago(20) });
    const s = flowStage(issue({ createdAt: ago(200), pulls: [closed] }), NOW);
    expect(s).toMatchObject({ stage: "issue", since: ago(20), pull: null });
  });

  test("a pull closed and re-opened counts from the re-open", () => {
    const reopened = pull({ openedAt: ago(3), closedAt: ago(20) });
    const s = flowStage(issue({ createdAt: ago(200), pulls: [reopened] }), NOW);
    expect(s).toMatchObject({ stage: "pull", since: ago(3), pull: 7 });
  });

  test("the furthest open pull speaks for the issue", () => {
    const early = pull({ number: 8 });
    const late = pull({ number: 9, checks: green, approvals: 1 });
    expect(flowStage(issue({ pulls: [early, late] }), NOW)).toMatchObject({
      stage: "land",
      pull: 9,
    });
  });
});

describe("GET /flow", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let headers: Record<string, string>;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-flow-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const post = (path: string, body: unknown, extra: Record<string, string> = {}) =>
      fetch(`${servers.url}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...extra },
        body: JSON.stringify(body),
      });
    await post("/api/v1/users", {
      username: "mira",
      email: "mira@f.dev",
      password: "flow-stage-pass",
    });
    const { token } = (await (
      await post("/api/v1/tokens", {
        adminConfirm: true,
        username: "mira",
        password: "flow-stage-pass",
        name: "f",
        scope: "rw",
      })
    ).json()) as { token: string };
    headers = { authorization: `Bearer ${token}` };
    await post("/api/v1/repos", { name: "app", visibility: "public" }, headers);
    await post("/api/v1/repos/mira/app/issues", { title: "first" }, headers);
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an open issue with nobody on it is at issue", async () => {
    const res = await fetch(`${servers.url}/api/v1/repos/mira/app/flow`, { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { open: { number: number; stage: string; unblock: string }[]; live: unknown[] };
    expect(body.open).toHaveLength(1);
    expect(body.open[0]).toMatchObject({ number: 1, stage: "issue", unblock: "assign a builder" });
    expect(body.live).toEqual([]);
  });

  test("an unknown repository is not found", async () => {
    const res = await fetch(`${servers.url}/api/v1/repos/mira/nope/flow`, { headers });
    expect(res.status).toBe(404);
  });
});

describe("readFlow over real records", () => {
  test("an issue walks pull → check → review → land → live", async () => {
    const { commitToBranch, createRepo } = await import("../src/actions/repos.ts");
    const { openPull } = await import("../src/actions/pulls.ts");
    const { createIssue } = await import("../src/core/issues.ts");
    const { createRun, claimRun, finishRun } = await import("../src/core/runs.ts");
    const { submitReview } = await import("../src/core/reviews.ts");
    const { createUser } = await import("../src/core/users.ts");
    const { readFlow } = await import("../src/flow/read.ts");
    const dir = await mkdtemp(join(tmpdir(), "forge-flow-read-"));
    const app = createApp({ dataDir: dir, port: 0 });
    try {
      const u = await createUser(app.db, {
        trusted: true,
        username: "alice",
        email: "alice@forge.local",
        password: "a-good-passphrase",
        adminIfFirst: true,
      });
      if (!u.ok) throw new Error(u.error);
      const made = await createRepo(app, u.value, { name: "e", visibility: "private" });
      if (!made.ok) throw new Error(String(made.error));
      const repo = { ...made.value, requireReview: true };
      await commitToBranch(app, u.value, repo, {
        message: "Start",
        files: [{ path: "README.md", content: "# e\n" }],
      });
      const issue = createIssue(app.db, { repoId: repo.id, authorId: u.value.id, title: "do it" });
      if (!issue.ok) throw new Error(String(issue.error));
      await commitToBranch(app, u.value, repo, {
        branch: "feature/x",
        base: "main",
        message: "x",
        files: [{ path: "x.txt", content: "x\n" }],
      });
      const opened = await openPull(app, u.value, repo, {
        title: "x",
        body: `Closes #${issue.value.number}`,
        baseBranch: "main",
        headBranch: "feature/x",
      });
      if (!opened.ok) throw new Error(String(opened.error));
      const pr = opened.value;
      const stageOf = () => {
        const f = readFlow(app.db, repo, { now: new Date(), scope: { sealed: true } });
        return f.open.find((s) => s.number === issue.value.number)?.stage;
      };
      expect(stageOf()).toBe("pull");

      const run = createRun(app.db, { repoId: repo.id, kind: "check", issueId: pr.id, commitOid: pr.headOid });
      expect(stageOf()).toBe("check");
      claimRun(app.db, run.id);
      finishRun(app.db, run.id, { state: "ok", summary: "" });
      expect(stageOf()).toBe("review");

      submitReview(app.db, { issueId: pr.id, authorId: u.value.id, state: "approved", body: "", commitOid: pr.headOid });
      expect(stageOf()).toBe("land");

      // Merged: the issue closes with it, and is `land` until production serves it.
      const mergedAt = new Date(Date.now() - 1000).toISOString();
      app.db.query("UPDATE pull SET merged_at = ?2 WHERE issue_id = ?1").run(pr.id, mergedAt);
      // landPull also closes the pull's own row, so it reaches the flow through closedSince.
      for (const id of [issue.value.id, pr.id])
        app.db.query("UPDATE issue SET state = 'closed', closed_at = ?2 WHERE id = ?1").run(id, mergedAt);
      const flow = () => readFlow(app.db, repo, { now: new Date(), scope: { sealed: true } });
      expect(flow().live).toEqual([]);
      const landing = flow().open.find((s) => s.number === issue.value.number);
      expect(landing).toMatchObject({ stage: "land", unblock: "wait for the production deploy" });

      const failed = createRun(app.db, { repoId: repo.id, kind: "deploy", env: "production" });
      claimRun(app.db, failed.id);
      finishRun(app.db, failed.id, { state: "failed", summary: "" });
      expect(flow().open.find((s) => s.number === issue.value.number)).toMatchObject({
        stage: "land",
        unblock: "redeploy production",
      });
      expect(flow().live).toEqual([]);

      const deploy = createRun(app.db, { repoId: repo.id, kind: "deploy", env: "production" });
      claimRun(app.db, deploy.id);
      finishRun(app.db, deploy.id, { state: "ok", summary: "" });
      const live = flow().live;
      expect(live).toHaveLength(1);
      expect(live[0]).toMatchObject({ number: issue.value.number, stage: "live", pull: pr.number });
      expect(flow().open.find((s) => s.number === issue.value.number)).toBeUndefined();
    } finally {
      app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("readFlow reads everything, and only what the viewer may see", () => {
  const setup = async () => {
    const { createRepo } = await import("../src/actions/repos.ts");
    const { createUser } = await import("../src/core/users.ts");
    const dir = await mkdtemp(join(tmpdir(), "forge-flow-big-"));
    const app = createApp({ dataDir: dir, port: 0 });
    const alice = await createUser(app.db, {
      trusted: true, username: "alice", email: "alice@forge.local",
      password: "a-good-passphrase", adminIfFirst: true,
    });
    const bob = await createUser(app.db, {
      trusted: true, username: "bob", email: "bob@forge.local", password: "a-good-passphrase",
    });
    if (!alice.ok || !bob.ok) throw new Error("users");
    const made = await createRepo(app, alice.value, { name: "big", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const repo = { ...made.value, requireReview: true };
    // Bulk rows, numbered from 1: `n` issues or pulls, each as given.
    let next = 1;
    const add = (kind: "issue" | "pull", over: { state?: string; closedAt?: string; sealed?: number; body?: string } = {}) => {
      const idv = `i${next}`;
      app.db
        .query(
          `INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, closed_at, sealed)
           VALUES (?1, ?2, ?3, ?4, 't', ?5, ?6, ?7, ?8, ?9)`,
        )
        .run(idv, repo.id, next, kind, over.body ?? "", alice.value.id, over.state ?? "open", over.closedAt ?? null, over.sealed ?? 0);
      if (kind === "pull")
        app.db
          .query("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid) VALUES (?1, 'main', 'x', 'a', 'b')")
          .run(idv);
      return next++;
    };
    return { app, dir, repo, add, bob: bob.value, alice: alice.value };
  };

  test("more than 200 open issues are all there, oldest included", async () => {
    const { readFlow } = await import("../src/flow/read.ts");
    const { app, dir, repo, add } = await setup();
    try {
      for (let i = 0; i < 253; i++) add("issue");
      const f = readFlow(app.db, repo, { now: new Date(), scope: { sealed: true } });
      expect(f.open).toHaveLength(253);
      expect(f.open.some((s) => s.number === 1)).toBe(true);
    } finally {
      app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an old open pull behind 200 newer closed ones still moves its issue", async () => {
    const { readFlow } = await import("../src/flow/read.ts");
    const { app, dir, repo, add } = await setup();
    try {
      const target = add("issue");
      const old = add("pull", { body: `Closes #${target}` });
      const closedAt = new Date().toISOString();
      for (let i = 0; i < 210; i++) add("pull", { state: "closed", closedAt });
      const f = readFlow(app.db, repo, { now: new Date(), scope: { sealed: true } });
      const s = f.open.find((x) => x.number === target);
      expect(s).toMatchObject({ stage: "pull", pull: old });
    } finally {
      app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a sealed blocker is not named to a guest, and is to the owner", async () => {
    const { readFlow } = await import("../src/flow/read.ts");
    const { sealedScope } = await import("../src/core/sealed.ts");
    const { app, dir, repo, add, bob, alice } = await setup();
    try {
      const sealed = add("issue", { sealed: 1 });
      const held = add("issue");
      app.db
        .query("INSERT INTO issue_dependency (issue_id, blocked_by_id) VALUES ('i2', 'i1')")
        .run();
      const asGuest = readFlow(app.db, repo, { now: new Date(), scope: sealedScope(app.db, repo, bob) });
      const heldGuest = asGuest.open.find((x) => x.number === held)!;
      expect(asGuest.open.some((x) => x.number === sealed)).toBe(false);
      expect(heldGuest.unblock).not.toContain(`#${sealed}`);
      const asOwner = readFlow(app.db, repo, { now: new Date(), scope: sealedScope(app.db, repo, alice) });
      expect(asOwner.open.find((x) => x.number === held)!.unblock).toBe(`finish #${sealed} first`);
    } finally {
      app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
