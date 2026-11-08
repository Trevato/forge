/**
 * Quiet runs: an agent run that ended without failing and left no push,
 * pull, comment or issue is out of the timeline and counted in one line.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createSession } from "../src/core/sessions.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { forkRepo, type Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { readFeed, quietRunCount } from "../src/feed/feed.ts";
import { quietRunEventIds } from "../src/feed/quiet.ts";
import type { ForgeEvent } from "../src/core/events.ts";
import { candidatesFor } from "../src/feed/items.ts";
import { noChips } from "../src/core/feed_chips.ts";
import { mcpTool } from "./helpers/mcp.ts";
import { promote } from "./helpers/members.ts";

describe("quiet runs", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let viewer: User;
  let quietAgent: User;
  let busyAgent: User;
  let forkAgent: User;
  let repo: Repo;
  let token: string;

  const mk = async (username: string, first = false) => {
    const r = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      allowReserved: true,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: first,
    });
    if (!r.ok) throw new Error(r.error);
    promote(app.db, r.value);
    return r.value;
  };

  /** A real run row, started and finished, and its `run.finished` on the outbox. */
  const finished = (actor: User, state: "ok" | "failed", costUsd = 0, push = false) => {
    const run = createRun(app.db, { repoId: repo.id, kind: "agent", actorId: actor.id });
    claimRun(app.db, run.id);
    if (push)
      app.bus.append({ kind: "push", repoId: repo.id, actorId: actor.id, payload: {} });
    const done = finishRun(app.db, run.id, { state, summary: "did it", costUsd })!;
    app.bus.append({
      kind: "run.finished",
      repoId: repo.id,
      actorId: actor.id,
      payload: { runId: done.id, kind: "agent", state, summary: "did it", costUsd },
    });
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-quiet-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    await mk("root", true);
    viewer = await mk("viewer");
    quietAgent = await mk("quiet-agent");
    busyAgent = await mk("busy-agent");
    forkAgent = await mk("fork-agent");
    token = createToken(app.db, viewer.id, "t", "rw").token;
    const r = await createRepo(app, viewer, { name: "open", visibility: "public" });
    if (!r.ok) throw new Error("repo");
    repo = r.value;
    for (let i = 0; i < 5; i++) finished(quietAgent, "ok");
    for (let i = 0; i < 2; i++) finished(busyAgent, "ok", 0, true);
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("5 quiet runs and 2 that pushed: 2 posts and 5 quiet runs", () => {
    const page = readFeed(app.db, viewer, { now: Date.now() });
    expect(page.items.filter((i) => i.kind === "run")).toHaveLength(2);
    expect(page.quietRuns).toBe(5);
  });

  test("a run that pushed only to the agent's fork stays in the timeline", async () => {
    const forked = await forkRepo(app.db, app.reposRoot, repo, forkAgent.id);
    if (!forked.ok) throw new Error("fork");
    const before = readFeed(app.db, viewer, { now: Date.now() });
    const run = createRun(app.db, { repoId: repo.id, kind: "agent", actorId: forkAgent.id });
    claimRun(app.db, run.id);
    app.bus.append({ kind: "push", repoId: forked.value.id, actorId: forkAgent.id, payload: {} });
    const done = finishRun(app.db, run.id, { state: "ok", summary: "fixed", costUsd: 0 })!;
    app.bus.append({
      kind: "run.finished",
      repoId: repo.id,
      actorId: forkAgent.id,
      payload: { runId: done.id, kind: "agent", state: "ok", summary: "fixed", costUsd: 0 },
    });
    const page = readFeed(app.db, viewer, { now: Date.now() });
    expect(page.items.filter((i) => i.kind === "run")).toHaveLength(
      before.items.filter((i) => i.kind === "run").length + 1,
    );
    expect(page.quietRuns).toBe(before.quietRuns);
  });

  test("a failed run and a costly run stay in the timeline", () => {
    finished(quietAgent, "failed");
    finished(quietAgent, "ok", 2);
    const page = readFeed(app.db, viewer, { now: Date.now() });
    expect(page.items.filter((i) => i.kind === "run" || i.kind === "cost")).toHaveLength(5);
    expect(page.quietRuns).toBe(5);
  });

  test("paging stays correct: cursor pages hold the posts and no quiet run", () => {
    const first = readFeed(app.db, viewer, { limit: 2, now: Date.now() });
    expect(first.next_cursor).not.toBeNull();
    const [id, score] = [first.items.at(-1)!.id, first.items.at(-1)!.score];
    const next = readFeed(app.db, viewer, { limit: 20, cursor: { id, score }, now: Date.now() });
    const ids = new Set([...first.items, ...next.items].map((i) => i.id));
    expect(ids.size).toBe(first.items.length + next.items.length);
    expect(first.items.length + next.items.length).toBe(
      readFeed(app.db, viewer, { limit: 50, now: Date.now() }).items.length,
    );
  });

  test("the home says it in one line linking to the runs list", async () => {
    const session = createSession(app.db, viewer.id);
    const res = await fetch(`${servers.url}/live/feed`, {
      headers: { cookie: `forge_session=${session.token}` },
    });
    const text = await res.text();
    expect(text).toContain("5 quiet runs in the last 24 h");
    expect(text).toContain(`href="/${repo.ownerName}/open/runs?kind=agent"`);
  });

  test("MCP feed and the API give quietRuns", async () => {
    const mcp = await mcpTool(servers.url, token, "feed");
    expect(mcp.value.quietRuns).toBe(5);
    expect(mcp.value.items.filter((i: { kind: string }) => i.kind === "run")).toHaveLength(4);
    const api = await fetch(`${servers.url}/api/v1/feed`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(((await api.json()) as { quietRuns: number }).quietRuns).toBe(5);
  });

  test("a muted app's quiet runs are not counted", () => {
    const now = Date.now();
    expect(quietRunCount(app.db, viewer, now, noChips, new Set(), false).count).toBe(5);
    expect(quietRunCount(app.db, viewer, now, noChips, new Set([repo.id]), false).count).toBe(0);
  });

  test("a hidden person's quiet runs are not counted", () => {
    const now = Date.now();
    const hidden = { kinds: new Set<never>(), people: new Set([quietAgent.id]) };
    expect(quietRunCount(app.db, viewer, now, hidden, new Set(), false).count).toBe(0);
  });

  test("quiet runs older than a day are neither counted nor hidden", () => {
    const later = Date.now() + 25 * 60 * 60 * 1000;
    expect(quietRunCount(app.db, viewer, later, noChips, new Set(), false).count).toBe(0);
    const runs = candidatesFor(app.db, viewer, later).filter((c) => c.kind === "run");
    expect(runs.length).toBeGreaterThanOrEqual(7);
  });

  test("the per-run lookup uses the actor index", () => {
    const plan = app.db
      .query<{ detail: string }, []>(
        "EXPLAIN QUERY PLAN SELECT 1 FROM event WHERE repo_id IN ('a','b') AND actor_id = 'c' AND created_at >= 'd' AND kind IN ('push') AND created_at <= 'e' LIMIT 1",
      )
      .all()
      .map((r) => r.detail)
      .join(" ");
    expect(plan).toContain("event_repo_actor_at");
  });
});

describe("quietRunEventIds", () => {
  const START = "2026-01-01T10:00:00.000Z";
  const END = "2026-01-01T10:10:00.000Z";
  const INSIDE = "2026-01-01T10:05:00.000Z";
  let dataDir: string;
  let app: App;
  let agent: User;
  let repo: Repo;
  let fork: Repo;

  const mkUser = async (username: string, first = false) => {
    const r = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      allowReserved: true,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: first,
    });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };

  /** A finished agent run with its window pinned; returns its `run.finished` event. */
  const run = (state: "ok" | "failed" = "ok", gone = false): ForgeEvent => {
    const r = createRun(app.db, { repoId: repo.id, kind: "agent", actorId: agent.id });
    claimRun(app.db, r.id);
    finishRun(app.db, r.id, { state, summary: "x", costUsd: 0 });
    app.db
      .query("UPDATE run SET started_at = ?1, finished_at = ?2 WHERE id = ?3")
      .run(START, END, r.id);
    if (gone) app.db.query("DELETE FROM run WHERE id = ?1").run(r.id);
    return {
      id: `fin-${r.id}`,
      kind: "run.finished",
      repoId: repo.id,
      actorId: agent.id,
      payload: { runId: r.id, kind: "agent", state, summary: "x", costUsd: 0 },
      createdAt: END,
    };
  };

  const wrote = (kind: string, at: string, repoId = repo.id) => {
    app.db
      .query(
        "INSERT INTO event (id, kind, repo_id, actor_id, payload, created_at) VALUES (?1, ?2, ?3, ?4, '{}', ?5)",
      )
      .run(`w-${Math.random().toString(36).slice(2)}`, kind, repoId, agent.id, at);
  };

  const isQuiet = (e: ForgeEvent) => quietRunEventIds(app.db, [e]).has(e.id);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-quiet-unit-"));
    app = createApp({ dataDir, port: 0 });
    const owner = await mkUser("owner", true);
    agent = await mkUser("agent");
    const r = await createRepo(app, owner, { name: "unit", visibility: "public" });
    if (!r.ok) throw new Error("repo");
    repo = r.value;
    const f = await forkRepo(app.db, app.reposRoot, repo, agent.id);
    if (!f.ok) throw new Error("fork");
    fork = f.value;
  });

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  // Every case starts from an empty event log, so a `false` can only come from its own cause.
  beforeEach(() => {
    app.db.query("DELETE FROM event WHERE kind != 'run.finished'").run();
  });

  test("a finished ok run whose agent wrote nothing in its window is quiet", () => {
    expect(isQuiet(run())).toBe(true);
  });

  const cases: [string, string, () => string][] = [
    ["a push to the repository", "push", () => repo.id],
    ["a push to the agent's fork", "push", () => fork.id],
    ["a pull", "pull.opened", () => repo.id],
    ["a comment", "issue.commented", () => repo.id],
    ["an issue", "issue.opened", () => repo.id],
  ];
  for (const [name, kind, where] of cases)
    test(`${name} in the window makes the run not quiet`, () => {
      const e = run();
      expect(isQuiet(e)).toBe(true);
      wrote(kind, INSIDE, where());
      expect(isQuiet(e)).toBe(false);
    });

  test("a failed run is never quiet", () => {
    expect(isQuiet(run("ok"))).toBe(true);
    expect(isQuiet(run("failed"))).toBe(false);
  });

  test("a run.finished whose run row is gone is never quiet", () => {
    expect(isQuiet(run("ok"))).toBe(true);
    expect(isQuiet(run("ok", true))).toBe(false);
  });

  test("something written just outside the window does not stop a run being quiet", () => {
    const e = run();
    // The window is closed at both ends; neighbours of a run are not its work.
    wrote("push", "2026-01-01T09:59:59.999Z");
    wrote("issue.opened", "2026-01-01T10:10:00.001Z");
    expect(isQuiet(e)).toBe(true);
  });
});
