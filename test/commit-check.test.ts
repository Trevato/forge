/**
 * The default branch's own check of one commit, what a release waits on
 * (#2794): only main's own check counts (never a pull's fast tier, never
 * another branch), the newest decides, a cancelled check says nothing, and
 * the API answers it by full commit id to whoever may read the runs.
 *
 * A release is never held because main moved (#3966): when the tagged
 * commit's own check was cancelled, or main never checked it alone, a green
 * check of a later main commit that contains it answers for it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { commitCheck, DESCENDANTS, releaseCheck } from "../src/checks/commit_check.ts";
import { migrations } from "../src/core/schema.ts";
import { cancelRun, claimRun, createRun, finishRun, requeueCheck } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import type { Repo } from "../src/core/repos.ts";
import { forgeHttp, type ForgeHttp } from "../src/http/server.ts";
import { openDb } from "../src/kernel/db.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const OID = (c: string) => c.repeat(40);

function check(db: Database, repoId: string, commit: string, opts: { env?: string; issueId?: string } = {}) {
  return createRun(db, {
    repoId,
    kind: "check",
    env: opts.env ?? "main",
    commitOid: commit.length === 40 ? commit : OID(commit),
    reason: "push",
    ...(opts.issueId === undefined ? {} : { issueId: opts.issueId }),
  });
}
function finish(db: Database, id: string, state: "ok" | "failed") {
  claimRun(db, id);
  finishRun(db, id, { state, summary: state === "ok" ? "check passed in 368s" : "check failed: 1 test failed" });
}

describe("commitCheck", () => {
  let db: Database;
  beforeAll(() => {
    db = openDb(":memory:", migrations);
    db.run("INSERT INTO user (id, username, email, password_hash) VALUES ('u1', 'trevato', 't@x', '')");
    db.run("INSERT INTO repo (id, owner_id, name) VALUES ('r1', 'u1', 'forge')");
    db.run(
      "INSERT INTO issue (id, repo_id, number, kind, title, author_id) VALUES ('i1', 'r1', 7, 'pull', 'p', 'u1')",
    );
  });

  test("a commit main never checked is none", () => {
    expect(commitCheck(db, "r1", "main", OID("a"))).toEqual({
      commit: OID("a"),
      checkedCommit: OID("a"),
      state: "none",
      runId: null,
      summary: "",
      finishedAt: null,
    });
  });

  test("a pull's check and another branch's check of the same commit do not count", () => {
    finish(db, check(db, "r1", "b", { env: "pull-7", issueId: "i1" }).id, "ok");
    finish(db, check(db, "r1", "b", { env: "next" }).id, "ok");
    expect(commitCheck(db, "r1", "main", OID("b")).state).toBe("none");
  });

  test("queued and running are pending; a finished check is its verdict", () => {
    const run = check(db, "r1", "c");
    expect(commitCheck(db, "r1", "main", OID("c")).state).toBe("pending");
    claimRun(db, run.id);
    expect(commitCheck(db, "r1", "main", OID("c")).state).toBe("pending");
    finishRun(db, run.id, { state: "ok", summary: "check passed in 368s" });
    expect(commitCheck(db, "r1", "main", OID("c"))).toMatchObject({
      state: "ok",
      runId: run.id,
      summary: "check passed in 368s",
    });
  });

  test("the newest check decides, and a cancelled one is passed over", () => {
    finish(db, check(db, "r1", "d").id, "failed");
    expect(commitCheck(db, "r1", "main", OID("d")).state).toBe("failed");
    const green = check(db, "r1", "d");
    finish(db, green.id, "ok");
    expect(commitCheck(db, "r1", "main", OID("d")).runId).toBe(green.id);
    cancelRun(db, check(db, "r1", "d").id);
    expect(commitCheck(db, "r1", "main", OID("d"))).toMatchObject({ state: "ok", runId: green.id });
  });

  test("a check main moved past before it ran is superseded, not none", () => {
    const waiting = check(db, "r1", "g");
    // What `checks/service.ts` does when a newer commit lands on main.
    cancelRun(db, waiting.id, `superseded by ${OID("h").slice(0, 7)}`);
    check(db, "r1", "h");
    expect(commitCheck(db, "r1", "main", OID("g"))).toMatchObject({
      state: "superseded",
      runId: waiting.id,
      summary: "superseded by hhhhhhh",
    });
  });

  test("a check a restart queued again is pending, not superseded", () => {
    const running = check(db, "r1", "k");
    claimRun(db, running.id);
    const again = requeueCheck(db, running.id);
    expect(again).toBeDefined();
    expect(commitCheck(db, "r1", "main", OID("k"))).toMatchObject({ state: "pending", runId: again!.again.id });
  });
});

describe("releaseCheck", () => {
  let db: Database;
  beforeEach(() => {
    db = openDb(":memory:", migrations);
    db.run("INSERT INTO user (id, username, email, password_hash) VALUES ('u1', 'trevato', 't@x', '')");
    db.run("INSERT INTO repo (id, owner_id, name) VALUES ('r1', 'u1', 'forge')");
  });
  /** `t` (the tag) is in every commit but `x`, which is on no line with it. */
  const contains = async (descendant: string) => descendant !== OID("x");
  const has = async () => true;
  const asked = (oid: string) => releaseCheck(db, "r1", "main", OID(oid), { has, contains });

  test("the tagged commit's own verdict answers as it is", async () => {
    const own = check(db, "r1", "t");
    finish(db, check(db, "r1", "u").id, "ok");
    expect(await asked("t")).toMatchObject({ state: "pending", checkedCommit: OID("t"), runId: own.id });
    claimRun(db, own.id);
    finishRun(db, own.id, { state: "failed", summary: "check failed: 1 test failed" });
    expect(await asked("t")).toMatchObject({ state: "failed", checkedCommit: OID("t") });
  });

  test("main moved on twice: the tag's cancelled check is answered by the descendant's green one", async () => {
    const tagged = check(db, "r1", "t");
    cancelRun(db, tagged.id, `superseded by ${OID("u").slice(0, 7)}`);
    const first = check(db, "r1", "u");
    cancelRun(db, first.id, `superseded by ${OID("v").slice(0, 7)}`);
    const second = check(db, "r1", "v");
    expect(await asked("t")).toMatchObject({ commit: OID("t"), checkedCommit: OID("v"), state: "pending", runId: second.id });
    finish(db, second.id, "ok");
    expect(await asked("t")).toMatchObject({
      commit: OID("t"),
      checkedCommit: OID("v"),
      state: "ok",
      runId: second.id,
      summary: "check passed in 368s",
    });
  });

  test("a commit main never checked alone, inside a checked batch, is answered by the batch's check", async () => {
    finish(db, check(db, "r1", "v").id, "ok");
    expect(await asked("t")).toMatchObject({ state: "ok", checkedCommit: OID("v") });
  });

  test("a later commit that does not contain the tag, or a red one, does not answer for it", async () => {
    const tagged = check(db, "r1", "t");
    cancelRun(db, tagged.id, "superseded by xxxxxxx");
    finish(db, check(db, "r1", "x").id, "ok");
    expect(await asked("t")).toMatchObject({ state: "superseded", checkedCommit: OID("t"), runId: tagged.id });
    finish(db, check(db, "r1", "v").id, "failed");
    expect((await asked("t")).state).toBe("superseded");
    expect((await asked("y")).state).toBe("none");
  });

  test("a green check older than the tag's own is never read as covering it", async () => {
    finish(db, check(db, "r1", "v").id, "ok");
    const tagged = check(db, "r1", "t");
    cancelRun(db, tagged.id, "stopped");
    expect((await asked("t")).state).toBe("superseded");
  });

  test("the newest green descendant answers before an older one still running", async () => {
    cancelRun(db, check(db, "r1", "t").id, "superseded");
    check(db, "r1", "u");
    const green = check(db, "r1", "v");
    finish(db, green.id, "ok");
    expect(await asked("t")).toMatchObject({ state: "ok", runId: green.id });
  });

  test("an oid the repository does not have answers none without asking any descendant", async () => {
    for (const c of "uvw") finish(db, check(db, "r1", c).id, "ok");
    let hasCalls = 0;
    let containsCalls = 0;
    const answer = await releaseCheck(db, "r1", "main", OID("z"), {
      has: async () => (hasCalls++, false),
      contains: async () => (containsCalls++, true),
    });
    expect(answer.state).toBe("none");
    expect(hasCalls).toBe(1);
    expect(containsCalls).toBe(0);
  });

  test("at most DESCENDANTS distinct later commits are asked", async () => {
    for (let i = 0; i < DESCENDANTS + 5; i++) finish(db, check(db, "r1", i.toString(16).padStart(40, "0")).id, "ok");
    let containsCalls = 0;
    const answer = await releaseCheck(db, "r1", "main", OID("z"), {
      has: async () => true,
      contains: async () => (containsCalls++, false),
    });
    expect(answer.state).toBe("none");
    expect(containsCalls).toBe(DESCENDANTS);
  });
});

describe("GET /api/v1/repos/:owner/:name/commits/:oid/check", () => {
  let dataDir: string;
  let app: App;
  let http: ForgeHttp;
  let alice: User;
  let forge: Repo;

  const get = async (path: string) => {
    const res = await http.handle(new Request(`http://forge.test${path}`));
    return { status: res.status, cache: res.headers.get("cache-control"), body: await res.text() };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-commit-check-"));
    app = createApp({ dataDir, port: 0 });
    http = forgeHttp(app);
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(String(made.error));
    alice = made.value;
    for (const [name, visibility] of [["forge", "public"], ["hidden", "private"]] as const) {
      const repo = await createRepo(app, made.value, { name, visibility });
      if (!repo.ok) throw new Error(String(repo.error));
      if (name === "forge") forge = repo.value;
      await commitToBranch(app, made.value, repo.value, {
        message: "Start",
        files: [{ path: "README.md", content: `# ${name}\n` }],
      });
      finish(app.db, check(app.db, repo.value.id, "e").id, "ok");
    }
  }, 60_000);

  afterAll(async () => {
    app?.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("answers main's own check of a full commit id, uncached", async () => {
    const res = await get(`/api/v1/repos/alice/forge/commits/${OID("e")}/check`);
    expect(res.status).toBe(200);
    expect(res.cache).toBe("no-store");
    expect(JSON.parse(res.body)).toMatchObject({ commit: OID("e"), state: "ok", summary: "check passed in 368s" });
    const none = await get(`/api/v1/repos/alice/forge/commits/${OID("f")}/check`);
    expect(JSON.parse(none.body)).toMatchObject({ state: "none", runId: null });
  });

  test("a short or malformed id, and a repository the caller cannot read, are 404", async () => {
    expect((await get(`/api/v1/repos/alice/forge/commits/eeeeeee/check`)).status).toBe(404);
    expect((await get(`/api/v1/repos/alice/forge/commits/${"E".repeat(40)}/check`)).status).toBe(404);
    expect((await get(`/api/v1/repos/alice/hidden/commits/${OID("e")}/check`)).status).toBe(404);
  });

  test("a tag whose check two landings cancelled builds on the descendant's green check, never on a stranger's", async () => {
    const repo = forge;
    const land = async (path: string, branch = "main") => {
      const done = await commitToBranch(app, alice, repo, {
        message: `Land ${path}`,
        branch,
        files: [{ path, content: `${path}\n` }],
      });
      if (!done.ok) throw new Error(String(done.error));
      return done.value.commitOid;
    };
    const tag = await land("release.txt");
    const tagged = check(app.db, repo.id, tag);
    const one = await land("one.txt");
    cancelRun(app.db, tagged.id, `superseded by ${one.slice(0, 7)}`);
    const first = check(app.db, repo.id, one);
    const two = await land("two.txt");
    cancelRun(app.db, first.id, `superseded by ${two.slice(0, 7)}`);
    const second = check(app.db, repo.id, two);
    const read = async () => JSON.parse((await get(`/api/v1/repos/alice/forge/commits/${tag}/check`)).body);
    expect(await read()).toMatchObject({ commit: tag, checkedCommit: two, state: "pending" });
    finish(app.db, second.id, "ok");
    expect(await read()).toMatchObject({ commit: tag, checkedCommit: two, state: "ok", runId: second.id });

    // A green check of a commit on another line does not contain the tag.
    const side = await land("side.txt", "side");
    const lone = check(app.db, repo.id, side);
    finish(app.db, lone.id, "ok");
    const sideTag = await land("side-two.txt", "side");
    const sideCheck = check(app.db, repo.id, sideTag);
    cancelRun(app.db, sideCheck.id, "superseded");
    finish(app.db, check(app.db, repo.id, await land("three.txt")).id, "ok");
    expect(JSON.parse((await get(`/api/v1/repos/alice/forge/commits/${sideTag}/check`)).body)).toMatchObject({
      checkedCommit: sideTag,
      state: "superseded",
    });
  });
});
