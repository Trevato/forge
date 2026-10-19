/**
 * The default branch's own check of one commit, what a release waits on
 * (#2794): only main's own check counts (never a pull's fast tier, never
 * another branch), the newest decides, a cancelled check says nothing, and
 * the API answers it by full commit id to whoever may read the runs.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { commitCheck } from "../src/checks/commit_check.ts";
import { migrations } from "../src/core/schema.ts";
import { cancelRun, claimRun, createRun, finishRun, requeueCheck } from "../src/core/runs.ts";
import { createUser } from "../src/core/users.ts";
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
    commitOid: OID(commit),
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

describe("GET /api/v1/repos/:owner/:name/commits/:oid/check", () => {
  let dataDir: string;
  let app: App;
  let http: ForgeHttp;

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
    for (const [name, visibility] of [["forge", "public"], ["hidden", "private"]] as const) {
      const repo = await createRepo(app, made.value, { name, visibility });
      if (!repo.ok) throw new Error(String(repo.error));
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
});
