/**
 * A conflicted pull never sits (#2039): a landing makes a crew pull
 * conflicted, the next tick queues one bring-up-to-date run, and a pull
 * that is still conflicted after two attempts is closed with its issue
 * ready again — no strike.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openIssue } from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { getIssueById } from "../src/core/issues.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun, listRuns } from "../src/core/runs.ts";
import { setCapacity } from "../src/core/capacity.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { parkedCount } from "../src/crew/parks.ts";
import { createToken } from "../src/core/tokens.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { settleAgentRun, sweepConflicts } from "../src/crew/autonomy.ts";
import { conflictedPulls, conflictedSays } from "../src/flow/conflicted.ts";
import { forgetFlow } from "../src/system/flow_cache.ts";
import { flowLines } from "../src/tui/screens/flow.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let alice: User;
let repo: Repo;
const fresh = () => getRepoById(app.db, repo.id)!;

/** /boards as the admin, and the MCP flow tool's `conflicted` field. */
async function flowDoors() {
  const signin = await fetch(`${servers.url}/signin`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: servers.url,
    },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
  });
  const cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const page = await (await fetch(`${servers.url}/boards`, { headers: { cookie } })).text();
  forgetFlow(app); // the MCP flow tool answers a copy a few seconds old
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
  const body = (await res.json()) as { result: { content: { text: string }[] } };
  const read = JSON.parse(body.result.content[0]!.text) as {
    conflicted: { says: string | null; pulls: { number: number }[] };
  };
  return { page, mcp: read.conflicted };
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-conflicts-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
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
  const made = await createRepo(app, alice, { name: "engine", visibility: "private" });
  if (!made.ok) throw new Error(String(made.error));
  repo = made.value;
  const seeded = await commitToBranch(app, alice, repo, {
    message: "Start",
    files: [{ path: "shared.ts", content: "export const shared = 0;\n" }],
  });
  if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  const agent = await createAgent(app, alice, { username: "mason" });
  if (!agent.ok) throw new Error(String(agent.error));
  expect(addToCrew(app, alice, repo, "mason").ok).toBe(true);
  app.db
    .query(
      "UPDATE repo SET autonomy = 'autonomous', autonomy_by = ?2 WHERE id = ?1",
    )
    .run(repo.id, alice.id);
});

afterAll(async () => {
  servers.stop();
  app.db.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("a pull a landing made conflicted is brought up to date within a tick; failing twice closes it and frees its issue", async () => {
  const mason = getUserByName(app.db, "mason")!;
  const ask = openIssue(app, alice, repo, { title: "Shared" });
  if (!ask.ok) throw new Error(String(ask.error));
  const branch = await commitToBranch(app, alice, repo, {
    branch: "feature/shared",
    base: "main",
    message: "Shared, the branch's way",
    files: [{ path: "shared.ts", content: "export const shared = 'branch';\n" }],
  });
  if (!branch.ok) throw new Error(JSON.stringify(branch.error));
  const opened = await openPull(app, mason, repo, {
    title: "Shared",
    body: `Closes #${ask.value.number}`,
    baseBranch: "main",
    headBranch: "feature/shared",
  });
  if (!opened.ok) throw new Error(String(opened.error));
  const pull = opened.value;

  // Clean so far: nothing is asked of anyone.
  expect(await sweepConflicts(app, fresh())).toBe(0);

  // A landing on main makes it conflicted.
  const moved = await commitToBranch(app, alice, repo, {
    branch: "main",
    message: "Shared, main's way",
    files: [{ path: "shared.ts", content: "export const shared = 'main';\n" }],
  });
  if (!moved.ok) throw new Error(JSON.stringify(moved.error));

  const conflicts = () =>
    listRuns(app.db, repo.id, { kind: "agent" }).filter(
      (r) => r.issueId === pull.id && r.reason === "conflict",
    );
  expect(await sweepConflicts(app, fresh())).toBe(1);
  expect(conflicts().length).toBe(1);
  // One in flight per pull: another tick queues no second.
  expect(await sweepConflicts(app, fresh())).toBe(0);
  expect(conflicts().length).toBe(1);
  expect(conflictedPulls(app.db).map((p) => p.number)).toEqual([pull.number]);
  expect(conflictedSays(conflictedPulls(app.db))).toContain(`engine#${pull.number}`);
  expect(flowLines(app.db).join("\n")).toContain("1 conflicted pull");
  const doors = await flowDoors();
  expect(doors.page).toContain('id="conflicted"');
  expect(doors.page).toContain(`engine#${pull.number}`);
  expect(doors.mcp.pulls.map((p) => p.number)).toEqual([pull.number]);
  expect(doors.mcp.says).toContain(`engine#${pull.number}`);

  // The run ends without pushing: the second attempt is queued.
  const first = conflicts()[0]!;
  claimRun(app.db, first.id);
  finishRun(app.db, first.id, { state: "failed", summary: "could not merge" });
  expect(await sweepConflicts(app, fresh())).toBe(1);
  expect(conflicts().length).toBe(2);
  expect(getIssueById(app.db, pull.id)!.state).toBe("open");

  // The second ends the same way: the pull closes, the issue is ready.
  const second = conflicts().find((r) => r.id !== first.id)!;
  claimRun(app.db, second.id);
  finishRun(app.db, second.id, { state: "failed", summary: "could not merge" });
  expect(await sweepConflicts(app, fresh())).toBe(1);
  expect(getIssueById(app.db, pull.id)!.state).toBe("closed");
  const freed = getIssueById(app.db, ask.value.id)!;
  expect(freed.state).toBe("open");
  expect(freed.assigneeId).toBeNull();
  // The reason is named on the issue, and it is no strike.
  const { listComments } = await import("../src/core/issues.ts");
  const said = listComments(app.db, freed.id).map((c) => c.body).join("\n");
  expect(said).toContain("shared.ts");
  expect(parkedCount(app.db, fresh(), freed.id)).toBe(0);
  expect(conflictedPulls(app.db)).toEqual([]);
  const after = await flowDoors();
  expect(after.page).not.toContain('id="conflicted"');
  expect(after.mcp).toEqual({ says: null, pulls: [] });
});

test("a pull brought up to date before is not closed for it: only the current conflict counts", async () => {
  const mason = getUserByName(app.db, "mason")!;
  const ask = openIssue(app, alice, repo, { title: "Other" });
  if (!ask.ok) throw new Error(String(ask.error));
  const write = async (branch: string, value: string, base?: string) => {
    const r = await commitToBranch(app, alice, repo, {
      branch,
      ...(base ? { base } : {}),
      message: `other ${value}`,
      files: [
        { path: "other.ts", content: `export const other = '${value}';\n` },
        // What only the branch adds, so it never just equals main.
        ...(branch === "main" ? [] : [{ path: "own-other.ts", content: "own\n" }]),
      ],
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
  };
  await write("feature/other", "branch", "main");
  const opened = await openPull(app, mason, repo, {
    title: "Other",
    body: `Closes #${ask.value.number}`,
    baseBranch: "main",
    headBranch: "feature/other",
  });
  if (!opened.ok) throw new Error(String(opened.error));
  const pull = opened.value;
  const conflicts = () =>
    listRuns(app.db, repo.id, { kind: "agent" }).filter(
      (r) => r.issueId === pull.id && r.reason === "conflict",
    );
  // Main and the branch each write other.ts differently, twice over: each
  // time the crew's run brings the branch level, and the pull merges again.
  for (let round = 1; round <= 3; round++) {
    await write("main", `main ${round}`);
    expect(await sweepConflicts(app, fresh())).toBe(1);
    expect(conflicts().length).toBe(round);
    const run = conflicts()[0]!;
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, { state: "ok", summary: "merged main" });
    await write("feature/other", `main ${round}`);
    expect(await sweepConflicts(app, fresh())).toBe(0);
    expect(getIssueById(app.db, pull.id)!.state).toBe("open");
  }
});

/** A fresh crew pull on its own file, and a way to move either side of it. */
async function pullOn(file: string) {
  const mason = getUserByName(app.db, "mason")!;
  const ask = openIssue(app, alice, repo, { title: file });
  if (!ask.ok) throw new Error(String(ask.error));
  const write = async (branch: string, value: string, base?: string) => {
    const r = await commitToBranch(app, alice, repo, {
      branch,
      ...(base ? { base } : {}),
      message: `${file} ${value}`,
      files: [
        { path: file, content: `export const v = '${value}';\n` },
        // What only the branch adds, so it never just equals main.
        ...(branch === "main" ? [] : [{ path: `own-${file}`, content: "own\n" }]),
      ],
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
  };
  await write(`feature/${file}`, "branch", "main");
  const opened = await openPull(app, mason, repo, {
    title: file,
    body: `Closes #${ask.value.number}`,
    baseBranch: "main",
    headBranch: `feature/${file}`,
  });
  if (!opened.ok) throw new Error(String(opened.error));
  const runs = () =>
    listRuns(app.db, repo.id, { kind: "agent" }).filter(
      (r) => r.issueId === opened.value.id && r.reason === "conflict",
    );
  return { pull: opened.value, ask: ask.value, write, runs };
}

test("an ok run that pushed is not a failed attempt when main moves again before the next tick", async () => {
  const { pull, write, runs } = await pullOn("pushed.ts");
  // The sweep has seen it clean once, so that is where its episodes begin.
  expect(await sweepConflicts(app, fresh())).toBe(0);
  // Three times the builder merges main and pushes, and main moves again
  // before any tick has seen the pull clean.
  for (let round = 1; round <= 3; round++) {
    await write("main", `main ${round}`);
    expect(await sweepConflicts(app, fresh())).toBe(1);
    expect(runs().length).toBe(round);
    const run = runs()[0]!;
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, { state: "ok", summary: "merged main and pushed" });
    await write("feature/pushed.ts", `main ${round}`);
    expect(getIssueById(app.db, pull.id)!.state).toBe("open");
  }
});

test("a pull still conflicted 24 hours after the first attempt is closed, and its issue freed", async () => {
  const { pull, ask, write, runs } = await pullOn("aged.ts");
  await write("main", "main 1");
  expect(await sweepConflicts(app, fresh())).toBe(1);
  const only = runs()[0]!;
  claimRun(app.db, only.id);
  finishRun(app.db, only.id, { state: "failed", summary: "could not merge" });
  const old = new Date(Date.now() - 25 * 3_600_000).toISOString();
  app.db.query("UPDATE run SET created_at = ?2 WHERE id = ?1").run(only.id, old);
  // The pull itself is older still, as one that sat for a day is.
  const older = new Date(Date.now() - 26 * 3_600_000).toISOString();
  app.db.query("UPDATE issue SET created_at = ?2 WHERE id = ?1").run(pull.id, older);
  expect(await sweepConflicts(app, fresh())).toBe(1);
  expect(getIssueById(app.db, pull.id)!.state).toBe("closed");
  const freed = getIssueById(app.db, ask.id)!;
  expect(freed.state).toBe("open");
  expect(freed.assigneeId).toBeNull();
  const { listComments } = await import("../src/core/issues.ts");
  const said = listComments(app.db, pull.id).map((c) => c.body).join("\n");
  expect(said).toContain("within 24 hours");
});

test("a pull whose change is already on main is closed by the first pass with no run, and its issue closes as done", async () => {
  const { pull, ask, runs } = await pullOn("carried.ts");
  // Main lands the very same change another way, after the branch was cut.
  const landed = await commitToBranch(app, alice, repo, {
    branch: "main",
    message: "carried.ts, landed another way",
    files: [
      { path: "carried.ts", content: "export const v = 'branch';\n" },
      { path: "own-carried.ts", content: "own\n" },
    ],
  });
  if (!landed.ok) throw new Error(JSON.stringify(landed.error));
  expect(await sweepConflicts(app, fresh())).toBe(1);
  expect(runs().length).toBe(0);
  expect(getIssueById(app.db, pull.id)!.state).toBe("closed");
  expect(getIssueById(app.db, ask.id)!.state).toBe("closed");
  const { listComments } = await import("../src/core/issues.ts");
  const said = listComments(app.db, pull.id).map((c) => c.body).join("\n");
  expect(said).toContain("already on main");
});

test("a run answering already done closes the pull as superseded and its issue as done", async () => {
  const { pull, ask, write, runs } = await pullOn("answered.ts");
  await write("main", "main 1");
  expect(await sweepConflicts(app, fresh())).toBe(1);
  const run = runs()[0]!;
  claimRun(app.db, run.id);
  const oid = "a".repeat(40);
  finishRun(app.db, run.id, { state: "ok", summary: `already done: ${oid}` });
  const mason = getUserByName(app.db, "mason")!;
  settleAgentRun(app, fresh(), {
    issueId: pull.id,
    state: "ok",
    summary: `already done: ${oid}`,
    reason: "conflict",
    actorId: mason.id,
  });
  expect(getIssueById(app.db, pull.id)!.state).toBe("closed");
  expect(getIssueById(app.db, ask.id)!.state).toBe("closed");
  const { listComments } = await import("../src/core/issues.ts");
  const said = listComments(app.db, pull.id).map((c) => c.body).join("\n");
  expect(said).toContain("aaaaaaaa");
});

test("the same main tip asks the crew at most twice", async () => {
  const { pull, write, runs } = await pullOn("capped.ts");
  await write("main", "main 1");
  for (let round = 1; round <= 2; round++) {
    expect(await sweepConflicts(app, fresh())).toBe(1);
    const run = runs().find((r) => r.state === "queued")!;
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, { state: "ok", summary: "nothing to push" });
  }
  expect(runs().length).toBe(2);
  expect(await sweepConflicts(app, fresh())).toBe(0);
  expect(runs().length).toBe(2);
  expect(getIssueById(app.db, pull.id)!.state).toBe("open");
});

test("one landing that conflicts many pulls starts only as many runs as the check lane has room for, oldest first (#4459)", async () => {
  // Only this test's pulls are open, so the slots are theirs alone.
  app.db.query("UPDATE issue SET state = 'closed' WHERE repo_id = ?1 AND kind = 'pull'").run(repo.id);
  const pulls = [await pullOn("lane-a.ts"), await pullOn("lane-b.ts"), await pullOn("lane-c.ts")];
  const shared = await commitToBranch(app, alice, repo, {
    branch: "main",
    message: "One landing under all three",
    files: pulls.map((_, i) => ({
      path: `lane-${"abc"[i]}.ts`,
      content: "export const v = 'main';\n",
    })),
  });
  if (!shared.ok) throw new Error(JSON.stringify(shared.error));
  setCapacity(app.db, "checks.concurrency", "3", alice.id);
  // A rebase's check already waits: two slots are left for the pushes to
  // come. Another kind of check does not stand in front of them (#6140).
  const mainCheck = createRun(app.db, { repoId: repo.id, kind: "check", env: "main" });
  const rebased = openIssue(app, alice, repo, { title: "Rebased elsewhere" });
  if (!rebased.ok) throw new Error(String(rebased.error));
  const pushedBy = createRun(app.db, { repoId: repo.id, kind: "agent", issueId: rebased.value.id, reason: "conflict" });
  claimRun(app.db, pushedBy.id);
  finishRun(app.db, pushedBy.id, { state: "ok", summary: "pushed" });
  const waiting = createRun(app.db, { repoId: repo.id, kind: "check", issueId: rebased.value.id });
  try {
    expect(await sweepConflicts(app, fresh())).toBe(2);
    expect(pulls.map((p) => p.runs().length)).toEqual([1, 1, 0]);
    // Nothing is free until a run or the check finishes.
    expect(await sweepConflicts(app, fresh())).toBe(0);
    claimRun(app.db, waiting.id);
    finishRun(app.db, waiting.id, { state: "ok", summary: "" });
    expect(await sweepConflicts(app, fresh())).toBe(1);
    expect(pulls.map((p) => p.runs().length)).toEqual([1, 1, 1]);
  } finally {
    for (const p of pulls)
      for (const run of p.runs()) {
        claimRun(app.db, run.id);
        finishRun(app.db, run.id, { state: "ok", summary: "" });
      }
    claimRun(app.db, mainCheck.id);
    finishRun(app.db, mainCheck.id, { state: "ok", summary: "" });
    setCapacity(app.db, "checks.concurrency", null, alice.id);
  }
});
