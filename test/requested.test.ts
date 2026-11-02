/**
 * A pull with changes requested always moves (#2172): a verdict on an
 * older head sends the reviewer back to the new green head; a verdict on
 * the current head queues one feedback run to the pull's builder,
 * assigning one when it has none. Both within one tick, and /flow says
 * which pulls wait on a builder and which on a reviewer.
 */

import { seatAs } from "./helpers/seat.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import {} from "../src/core/agents.ts";
import { getIssueById, listComments } from "../src/core/issues.ts";
import { getPull, type Pull } from "../src/core/pulls.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { submitReview } from "../src/core/reviews.ts";
import { claimRun, createRun, finishRun, listRuns } from "../src/core/runs.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { autonomyTick } from "../src/crew/autonomy.ts";
import { HANDOVER_NOTE } from "../src/crew/guard.ts";
import { moveRequested, tallyRequested, tallyWords } from "../src/crew/requested.ts";
import { requestedSays, requestedWaits } from "../src/flow/requested.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createToken } from "../src/core/tokens.ts";
import { flowLines } from "../src/tui/screens/flow.ts";
import { flowFor } from "../src/system/telemetry.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const HOUR = 60 * 60_000;

describe("a pull with changes requested always moves", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let alice: User;
  let builder: User;
  let reviewer: User;
  let repo: Repo;
  let n = 0;

  const fresh = () => getRepoById(app.db, repo.id)!;
  const reload = (pull: Pull) => getPull(app.db, repo.id, pull.number)!;
  const runs = (pull: Pull, reason: string) =>
    listRuns(app.db, repo.id, { issueId: pull.id }).filter(
      (r) => r.kind === "agent" && r.reason === reason,
    );
  const push = async (branch: string, base?: string) => {
    const c = await commitToBranch(app, alice, repo, {
      branch,
      ...(base === undefined ? {} : { base }),
      message: `${branch} ${++n}`,
      files: [{ path: `${branch}.md`, content: `${n}\n` }],
    });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
  };
  /** A builder's pull, opened on a branch of its own. */
  const builderPull = async (): Promise<Pull> => {
    const branch = `b${++n}`;
    await push(branch, "main");
    const o = await openPull(app, builder, repo, {
      title: branch,
      body: "",
      baseBranch: "main",
      headBranch: branch,
    });
    if (!o.ok) throw new Error(String(o.error));
    return o.value;
  };
  /** The head's check, green `ago` milliseconds back. */
  const green = (pull: Pull, ago: number) => {
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      issueId: pull.id,
      env: `pull-${pull.number}`,
      commitOid: pull.headOid,
      reason: "pull",
    });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, { state: "ok", summary: "ok" });
    const at = new Date(Date.now() - ago).toISOString();
    app.db
      .query("UPDATE run SET created_at = ?2, finished_at = ?2 WHERE id = ?1")
      .run(run.id, at);
  };
  const changesRequested = (pull: Pull) => {
    const r = submitReview(app.db, {
      issueId: pull.id,
      authorId: reviewer.id,
      state: "changes_requested",
      body: "Fix the one thing.",
      commitOid: pull.headOid,
    });
    if (!r.ok) throw new Error(r.error);
  };
  /** Shape 1: changes requested, then a push the reviewer was never asked about, green long ago. */
  const staleShape = async () => {
    const pull = await builderPull();
    green(pull, 4 * HOUR);
    changesRequested(pull);
    await push(pull.headBranch);
    const pushed = reload(pull);
    expect(pushed.headOid).not.toBe(pull.headOid);
    green(pushed, 3 * HOUR);
    return pushed;
  };
  /** Shape 2: changes requested on the current head, no assignee, no run since. */
  const currentShape = async () => {
    const pull = await builderPull();
    green(pull, HOUR);
    changesRequested(pull);
    // An agent's pull starts assigned to its author; this one was let go.
    app.db.query("UPDATE issue SET assignee_id = NULL WHERE id = ?1").run(pull.id);
    return pull;
  };
  const clearRuns = () =>
    app.db.query("UPDATE run SET state = 'ok' WHERE kind = 'agent' AND state IN ('queued','running')").run();

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-requested-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    alice = made.value;
    const r = await createRepo(app, alice, { name: "garden", visibility: "private" });
    if (!r.ok) throw new Error(String(r.error));
    repo = r.value;
    await push("main");
    for (const name of ["mason", "quill"]) {
      const agent = await createAgent(app, alice, { username: name });
      if (!agent.ok) throw new Error(String(agent.error));
      expect(addToCrew(app, alice, repo, name).ok).toBe(true);
    }
    builder = getUserByName(app.db, "mason")!;
    reviewer = getUserByName(app.db, "quill")!;
    seatAs(app.db, repo.id, reviewer.id, "reviewer");
    // Assisted: a lapsed head is not sent for being autonomous, only for answering a verdict.
    app.db
      .query("UPDATE repo SET autonomy = 'assisted', autonomy_by = ?2, autonomy_slots = 3 WHERE id = ?1")
      .run(repo.id, alice.id);
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a verdict on an older head: the reviewer is asked about the new green head", async () => {
    const pull = await staleShape();
    const moves = await moveRequested(app, fresh(), 0);
    expect(moves).toContainEqual({ pull: pull.number, did: "asked reviewer" });
    const sent = runs(pull, "review");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.actorId).toBe(reviewer.id);
    // Asked once: the review in flight is waited for, not sent again.
    const again = await moveRequested(app, fresh(), 0);
    expect(again.find((m) => m.pull === pull.number)?.did).toBe("not moved");
    expect(runs(pull, "review")).toHaveLength(1);
    clearRuns();
  });

  test("a verdict on an older head whose new head is not green waits for the check", async () => {
    const pull = await builderPull();
    changesRequested(pull);
    await push(pull.headBranch);
    const moves = await moveRequested(app, fresh(), 3);
    expect(moves.find((m) => m.pull === pull.number)).toEqual({
      pull: pull.number,
      did: "not moved",
      why: "the new head is not green yet",
    });
    app.db.query("UPDATE issue SET state = 'closed' WHERE id = ?1").run(pull.id);
  });

  test("a verdict on the current head: one feedback run to the builder, assigned when the pull had none", async () => {
    const pull = await currentShape();
    expect(getIssueById(app.db, pull.id)!.assigneeId).toBeNull();
    // No slot, no run.
    const full = await moveRequested(app, fresh(), 0);
    expect(full.find((m) => m.pull === pull.number)).toEqual({
      pull: pull.number,
      did: "not moved",
      why: "waits for a builder slot",
    });
    expect(runs(pull, "feedback")).toHaveLength(0);

    const moves = await moveRequested(app, fresh(), 1);
    expect(moves).toContainEqual({
      pull: pull.number,
      did: "queued feedback",
      builder: "mason",
      assigned: true,
    });
    expect(getIssueById(app.db, pull.id)!.assigneeId).toBe(builder.id);
    expect(runs(pull, "feedback")).toHaveLength(1);
    // One in flight per pull.
    const again = await moveRequested(app, fresh(), 1);
    expect(again.find((m) => m.pull === pull.number)).toEqual({
      pull: pull.number,
      did: "not moved",
      why: "a run is in flight",
    });
    app.db.query("UPDATE issue SET state = 'closed' WHERE id = ?1").run(pull.id);
  });

  test("a run that ended without a push is asked once more with the verdict and its answer, then a person has it", async () => {
    const pull = await currentShape();
    await moveRequested(app, fresh(), 1);
    expect(runs(pull, "feedback")).toHaveLength(1);
    // The first try ends without a push, saying why.
    app.db
      .query("UPDATE run SET state = 'ok', started_at = created_at, finished_at = created_at, summary = 'I could not reproduce it.' WHERE issue_id = ?1 AND reason = 'feedback'")
      .run(pull.id);

    // Exactly one new run within one tick; a second tick starts no other.
    const second = await moveRequested(app, fresh(), 1);
    expect(second).toContainEqual({
      pull: pull.number,
      did: "queued feedback",
      builder: "mason",
      assigned: false,
    });
    expect(runs(pull, "feedback")).toHaveLength(2);
    const again = await moveRequested(app, fresh(), 1);
    expect(again.find((m) => m.pull === pull.number)).toEqual({
      pull: pull.number,
      did: "not moved",
      why: "a run is in flight",
    });
    expect(runs(pull, "feedback")).toHaveLength(2);
    // After the second also ends without a push: handed over, once, and no third run.
    clearRuns();
    for (let i = 0; i < 2; i++) {
      const over = await moveRequested(app, fresh(), 1);
      expect(over.find((m) => m.pull === pull.number)).toEqual({
        pull: pull.number,
        did: "not moved",
        why: "handed to a person after two follow-ups ended without a push",
      });
    }
    expect(runs(pull, "feedback")).toHaveLength(2);
    const notes = listComments(app.db, pull.id).filter((c) => c.body.startsWith(HANDOVER_NOTE));
    expect(notes).toHaveLength(1);
    app.db.query("UPDATE issue SET state = 'closed' WHERE id = ?1").run(pull.id);
  });

  test("an approval after the request: nothing to move", async () => {
    const pull = await currentShape();
    submitReview(app.db, {
      issueId: pull.id,
      authorId: reviewer.id,
      state: "approved",
      commitOid: pull.headOid,
    });
    const moves = await moveRequested(app, fresh(), 3);
    expect(moves.find((m) => m.pull === pull.number)).toBeUndefined();
    app.db.query("UPDATE issue SET state = 'closed' WHERE id = ?1").run(pull.id);
  });

  test("both shapes move within one tick, and /boards tells them apart", async () => {
    // Every earlier pull is settled: only these two are in play.
    app.db.query("UPDATE issue SET state = 'closed' WHERE repo_id = ?1 AND kind = 'pull'").run(repo.id);
    const stale = await staleShape();
    const current = await currentShape();

    const waits = requestedWaits(app.db);
    expect(waits.reviewer.map((p) => p.number)).toEqual([stale.number]);
    expect(waits.builder.map((p) => p.number)).toEqual([current.number]);
    // A reader kept from private names (an agent on /flow) sees neither.
    const outside = requestedWaits(app.db, true);
    expect([...outside.builder, ...outside.reviewer]).toEqual([]);
    expect(requestedSays(waits.builder, "builder")).toStartWith(
      `1 pull with changes requested waits on a builder, oldest first: alice/garden#${current.number} `,
    );

    const signin = await fetch(`${servers.url}/signin`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
      body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    });
    const cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const page = await (await fetch(`${servers.url}/boards`, { headers: { cookie } })).text();
    expect(page).toContain(`id="requested-builder"`);
    expect(page).toContain(`waits on a reviewer, oldest first: alice/garden#${stale.number} `);

    // The terminal's Flow dialog says the same; an agent's is cut to public.
    const dialog = flowLines(app.db).join(" ");
    expect(dialog).toContain("waits on a builder");
    expect(dialog).toContain("waits on a reviewer");
    const agentDialog = flowLines(app.db, new Date(), undefined, { queues: [] }).join(" ");
    expect(agentDialog).not.toContain("changes requested");

    // So does the MCP flow tool.
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${createToken(app.db, alice.id, "t", "ro").token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "flow", arguments: {} },
      }),
    });
    const tool = (await res.json()) as { result: { content: { text: string }[] } };
    const read = JSON.parse(tool.result.content[0]!.text) as {
      requested: Record<"builder" | "reviewer", { says: string | null; pulls: { number: number }[] }>;
    };
    expect(read.requested.builder.pulls.map((p) => p.number)).toEqual([current.number]);
    expect(read.requested.reviewer.pulls.map((p) => p.number)).toEqual([stale.number]);
    expect(read.requested.reviewer.says).toContain(`garden#${stale.number}`);
    // An agent reader's telemetry has the private repository's pulls cut out.
    const agentFlow = flowFor(app, { kind: "agent" }).requested;
    expect([...agentFlow.builder.pulls, ...agentFlow.reviewer.pulls]).toEqual([]);
    expect(agentFlow.builder.says).toBeNull();

    await autonomyTick(app, new Date(), async () => 0);
    expect(runs(stale, "review")).toHaveLength(1);
    expect(runs(current, "feedback")).toHaveLength(1);
    expect(runs(current, "feedback")[0]!.actorId).toBe(builder.id);
  });

  test("the tally counts moved pulls and groups the rest by reason", async () => {
    app.db.query("UPDATE issue SET state = 'closed' WHERE repo_id = ?1 AND kind = 'pull'").run(repo.id);
    clearRuns();
    const stale = await staleShape();
    const fresh1 = await currentShape();
    const held = await currentShape();
    app.db.query("UPDATE issue SET assignee_id = ?2 WHERE id = ?1").run(held.id, alice.id);
    // Assigned to a builder: the assignment queues the run, which counts once.
    const moves = await moveRequested(app, fresh(), 2);
    const tally = tallyRequested(moves);
    expect(tally).toEqual({ moved: 2, total: 3, waiting: { "handed to a person": 1 } });
    expect(tallyWords(tally)).toBe("2/3 moved; 1 handed to a person");
    expect(runs(fresh1, "feedback")).toHaveLength(1);
    expect(runs(stale, "review")).toHaveLength(1);
    // Next pass: both runs are in flight, the person's pull still waits.
    const next = tallyRequested(await moveRequested(app, fresh(), 2));
    expect(next).toEqual({ moved: 0, total: 3, waiting: { "a run is in flight": 2, "handed to a person": 1 } });
    expect(tallyWords(next)).toBe("0/3 moved; 2 a run is in flight, 1 handed to a person");
  });
});
