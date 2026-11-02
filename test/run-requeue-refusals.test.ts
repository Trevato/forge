/**
 * Requeueing a crew run (#7086): only a failed or cancelled agent run, with
 * its task still there, by a person who may run the crew. Each refusal has
 * its own word, and none of them leaves a run behind.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setArchivedIn } from "./helpers/archive.ts";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { requeueRepoRun } from "../src/actions/runs.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { cancelRun, createRun, finishRun, listRuns, claimRun, type Run } from "../src/core/runs.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("requeueing a crew run", () => {
  let dataDir = "";
  let app: App;
  let alice: User;
  let helper: User;
  let lab: Repo;
  let other: Repo;
  let bob: User; // a guest: may write to his own repository, may not run the crew
  let open: Repo; // public, alice's
  let bobs: Repo;
  let n = 0;

  const count = (repo: Repo = lab) => listRuns(app.db, repo.id, { limit: 500 }).length;
  /** Each test owns its task: a fresh open issue. */
  const taskIn = (repo: Repo): string => {
    const issue = openIssue(app, alice, repo, { title: `task ${++n}`, body: "" });
    if (!issue.ok) throw new Error(String(issue.error));
    return issue.value.id;
  };
  const agentRun = (issueId: string | null = taskIn(lab), repo: Repo = lab): Run =>
    createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: issueId ?? undefined,
      actorId: helper.id,
      reason: "assigned",
    });
  const failed = (repo: Repo = lab, issueId?: string): Run => {
    const run = agentRun(issueId ?? taskIn(repo), repo);
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, { state: "failed", summary: "boom" });
    return run;
  };
  const refused = (actor: User | undefined, repo: Repo, run: Run, error: string) => {
    const before = count(repo);
    expect(requeueRepoRun(app, actor, repo, run.id)).toMatchObject({ ok: false, error });
    expect(count(repo)).toBe(before);
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-requeue-"));
    app = createApp({ dataDir, port: 0 });
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
    const r1 = await createRepo(app, alice, { name: "lab", visibility: "private" });
    const r2 = await createRepo(app, alice, { name: "elsewhere", visibility: "private" });
    if (!r1.ok || !r2.ok) throw new Error("repo");
    lab = getRepoById(app.db, r1.value.id)!;
    other = getRepoById(app.db, r2.value.id)!;
    const agent = await createAgent(app, alice, { username: "helper" });
    if (!agent.ok) throw new Error(String(agent.error));
    helper = agent.value.user;
    const crewed = addToCrew(app, alice, lab, "helper");
    if (!crewed.ok) throw new Error(crewed.error);
    const b = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!b.ok) throw new Error(b.error);
    bob = b.value;
    const r3 = await createRepo(app, alice, { name: "open", visibility: "public" });
    const r4 = await createRepo(app, alice, { name: "bobs", visibility: "private" });
    if (!r3.ok || !r4.ok) throw new Error("repo");
    app.db.query("UPDATE repo SET owner_id = ?1 WHERE id = ?2").run(bob.id, r4.value.id);
    open = getRepoById(app.db, r3.value.id)!;
    bobs = getRepoById(app.db, r4.value.id)!;
    const crewed2 = addToCrew(app, bob, bobs, "helper");
    if (!crewed2.ok) throw new Error(crewed2.error);
  }, 60_000);

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a failed agent run is queued again for the same task", () => {
    const run = failed();
    const before = count();
    const again = requeueRepoRun(app, alice, lab, run.id);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.id).not.toBe(run.id);
    expect(again.value).toMatchObject({ kind: "agent", state: "queued", issueId: run.issueId, actorId: helper.id, reason: "assigned" });
    expect(count()).toBe(before + 1);
  });

  test("a cancelled agent run is queued again too", () => {
    const run = agentRun();
    cancelRun(app.db, run.id, "test");
    expect(requeueRepoRun(app, alice, lab, run.id)).toMatchObject({ ok: true, value: { state: "queued" } });
  });

  test("a run already waiting for the same task is not_queued", () => {
    const issue = taskIn(lab);
    const run = failed(lab, issue);
    agentRun(issue);
    refused(alice, lab, run, "not_queued");
  });

  test("a check run is not_agent", () => {
    const run = createRun(app.db, { repoId: lab.id, kind: "check" });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, { state: "failed", summary: "red" });
    refused(alice, lab, run, "not_agent");
  });

  test("a queued, running or succeeded run is not_finished", () => {
    const queued = agentRun();
    refused(alice, lab, queued, "not_finished");
    const running = agentRun();
    claimRun(app.db, running.id);
    refused(alice, lab, running, "not_finished");
    const done = agentRun();
    claimRun(app.db, done.id);
    finishRun(app.db, done.id, { state: "ok", summary: "fine" });
    refused(alice, lab, done, "not_finished");
  });

  test("a run whose issue is gone is no_task", () => {
    const orphan = agentRun(null);
    cancelRun(app.db, orphan.id, "test");
    refused(alice, lab, orphan, "no_task");
    const closed = openIssue(app, alice, lab, { title: "done", body: "" });
    if (!closed.ok) throw new Error(String(closed.error));
    const run = agentRun(closed.value.id);
    cancelRun(app.db, run.id, "test");
    app.db.query("UPDATE issue SET state = 'closed' WHERE id = ?1").run(closed.value.id);
    refused(alice, lab, run, "no_task");
  });

  test("a run from another repository is not_found", () => {
    const run = failed();
    const before = count();
    const otherBefore = listRuns(app.db, other.id, { limit: 500 }).length;
    expect(requeueRepoRun(app, alice, other, run.id)).toMatchObject({ ok: false, error: "not_found" });
    expect(requeueRepoRun(app, alice, lab, "no-such-run")).toMatchObject({ ok: false, error: "not_found" });
    expect(count()).toBe(before);
    expect(listRuns(app.db, other.id, { limit: 500 }).length).toBe(otherBefore);
  });

  test("a person who may not run the crew is not_member", () => {
    const run = failed(bobs);
    refused(bob, bobs, run, "not_member");
  });

  test("an anonymous caller is unauthorized, and a reader who cannot write is forbidden", () => {
    const run = failed(open);
    refused(undefined, open, run, "unauthorized");
    refused(bob, open, run, "forbidden");
  });

  test("an archived repository is archived", () => {
    const run = failed();
    const archived = setArchivedIn(app.db, lab, true);
    try {
      refused(alice, archived, run, "archived");
    } finally {
      setArchivedIn(app.db, lab, false);
    }
  });

  test("an agent caller is forbidden", () => {
    refused(helper, lab, failed(), "forbidden");
  });
});
