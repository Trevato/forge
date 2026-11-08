/**
 * A fix the owner or a steward writes lands through the queue as it is
 * (#7572): a person's pull from a branch of the repository itself is a
 * normal pull. A push to its branch moves its head and starts its check;
 * changes asked for on it go back to its author, never to a builder who
 * cannot push that branch; and the crew never parks it, so it never stops
 * following its branch.
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
import { startChecks, type ChecksHandle } from "../src/checks/service.ts";
import {} from "../src/core/agents.ts";
import { getIssueById } from "../src/core/issues.ts";
import { getPull, type Pull } from "../src/core/pulls.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { submitReview } from "../src/core/reviews.ts";
import { listRuns } from "../src/core/runs.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { authorsInRepoPull, BACK_WITH_AUTHOR } from "../src/crew/authors_pull.ts";
import { parkPull, settleAgentRun } from "../src/crew/autonomy.ts";
import { finishApproved } from "../src/crew/finishing.ts";
import { moveRequested } from "../src/crew/requested.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("a person's in-repo pull is a normal pull the crew leaves to its author", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let checks: ChecksHandle;
  let alice: User;
  let builder: User;
  let reviewer: User;
  let repo: Repo;
  let n = 0;

  const fresh = () => getRepoById(app.db, repo.id)!;
  const reload = (pull: Pull) => getPull(app.db, repo.id, pull.number)!;
  const push = async (by: User, branch: string, base?: string): Promise<string> => {
    const c = await commitToBranch(app, by, repo, {
      branch,
      ...(base === undefined ? {} : { base }),
      message: `${branch} ${++n}`,
      files: [{ path: `${branch.replace("/", "-")}.md`, content: `${n}\n` }],
    });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
    return c.value.commitOid;
  };
  /** A pull `by` opens on a branch of the repository, pushed by alice: an agent writes only its fork. */
  const pullBy = async (by: User, branch: string): Promise<Pull> => {
    await push(alice, branch, "main");
    const o = await openPull(app, by, repo, { title: branch, body: "", baseBranch: "main", headBranch: branch });
    if (!o.ok) throw new Error(String(o.error));
    return o.value;
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
  const agentRuns = (pull: Pull) =>
    listRuns(app.db, repo.id, { issueId: pull.id }).filter((r) => r.kind === "agent" && r.reason !== "review");

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-authors-pull-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    checks = startChecks(app, { forgeUrl: servers.url, concurrency: 1 });
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
    const gate = await commitToBranch(app, alice, repo, {
      message: "The check",
      files: [{ path: "forge.json", content: `{"check": {"run": "true", "install": ""}}\n` }],
    });
    if (!gate.ok) throw new Error(JSON.stringify(gate.error));
    for (const name of ["mason", "quill"]) {
      const agent = await createAgent(app, alice, { username: name });
      if (!agent.ok) throw new Error(String(agent.error));
      expect(addToCrew(app, alice, repo, name).ok).toBe(true);
    }
    builder = getUserByName(app.db, "mason")!;
    reviewer = getUserByName(app.db, "quill")!;
    seatAs(app.db, repo.id, reviewer.id, "reviewer");
    app.db
      .query("UPDATE repo SET autonomy = 'autonomous', autonomy_by = ?2, autonomy_slots = 3 WHERE id = ?1")
      .run(repo.id, alice.id);
  }, 30_000);

  afterAll(async () => {
    await checks.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("only a person's pull from a branch of the repository itself is one", () => {
    expect(authorsInRepoPull({ authorIsAgent: false, crossRepo: false })).toBe(true);
    expect(authorsInRepoPull({ authorIsAgent: true, crossRepo: false })).toBe(false);
    expect(authorsInRepoPull({ authorIsAgent: false, crossRepo: true })).toBe(false);
  });

  test("a push to its branch moves the pull's head and starts a check of the new head", async () => {
    const pull = await pullBy(alice, "steward/one");
    const tip = await push(alice, pull.headBranch);
    expect(reload(pull).headOid).toBe(tip);
    const deadline = Date.now() + 10_000;
    let checked = false;
    while (!checked && Date.now() < deadline) {
      checked = listRuns(app.db, repo.id, { kind: "check", limit: 100 }).some(
        (r) => r.issueId === pull.id && r.commitOid === tip && r.env === `pull-${pull.number}`,
      );
      if (!checked) await Bun.sleep(50);
    }
    expect(checked).toBe(true);
  });

  test("changes asked for on it go back to its author: no builder is sent, even one already on it", async () => {
    const pull = await pullBy(alice, "steward/two");
    // A builder's name on it, as #7436 had.
    app.db.query("UPDATE issue SET assignee_id = ?2 WHERE id = ?1").run(pull.id, builder.id);
    changesRequested(pull);
    const moves = await moveRequested(app, fresh(), 3);
    expect(moves.find((m) => m.pull === pull.number)).toEqual({
      pull: pull.number,
      did: "not moved",
      why: BACK_WITH_AUTHOR,
    });
    expect(getIssueById(app.db, pull.id)!.assigneeId).toBe(alice.id);
    expect(agentRuns(pull)).toHaveLength(0);
    // Said again on a later tick, and still nothing queued.
    await moveRequested(app, fresh(), 3);
    expect(agentRuns(pull)).toHaveLength(0);
  });

  test("a builder's run on it that pushed nothing does not park it, and its next push still moves its head", async () => {
    const pull = await pullBy(alice, "steward/three");
    changesRequested(pull);
    const parked = settleAgentRun(app, fresh(), {
      issueId: pull.id,
      state: "failed",
      summary: `pull #${pull.number}'s branch lives in the repository itself`,
      reason: "feedback",
      actorId: builder.id,
    });
    expect(parked).toBe(false);
    expect(parkPull(app, fresh(), pull, "the check stayed red")).toBe(false);
    expect(getIssueById(app.db, pull.id)!.state).toBe("open");
    const tip = await push(alice, pull.headBranch);
    expect(reload(pull).headOid).toBe(tip);
  });

  test("a builder's own in-repo pull is still parked as before", async () => {
    const pull = await pullBy(builder, "b-legacy");
    expect(parkPull(app, fresh(), pull, "the check stayed red")).toBe(true);
    expect(getIssueById(app.db, pull.id)!.state).toBe("closed");
  });

  test("the finishing pass leaves it alone: not a candidate, and still open", async () => {
    const pull = await pullBy(alice, "steward/four");
    const r = submitReview(app.db, {
      issueId: pull.id,
      authorId: reviewer.id,
      state: "approved",
      body: "",
      commitOid: pull.headOid,
    });
    if (!r.ok) throw new Error(r.error);
    // Main moves under it on the same file: approved and conflicted.
    await commitToBranch(app, alice, repo, {
      message: "main moves",
      files: [{ path: "steward-four.md", content: "main\n" }],
    });
    const pass = await finishApproved(app, fresh(), 3);
    expect(pass.moves.find((m) => m.pull === pull.number)).toBeUndefined();
    expect(agentRuns(pull)).toHaveLength(0);
    expect(getIssueById(app.db, pull.id)!.state).toBe("open");
  });
});
