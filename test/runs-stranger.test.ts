/**
 * What a stranger may read of a repository's runs (#2917). A public
 * repository's runs answer anyone with what ran, why and how it ended —
 * never the agent session a follow-up resumes, the node a check ran on, or
 * what it cost; its writers read all of it. A private repository's runs are
 * a 404 to anyone it is not shared with, the same 404 as no repository.
 * Every door says the same: the API, the run page, MCP `now` and the
 * terminal's run rows all read through `runForReader`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { listRepoRuns } from "../src/actions/runs.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun, noteRunProgress } from "../src/core/runs.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { forgeHttp, type ForgeHttp } from "../src/http/server.ts";
import { runRows } from "../src/tui/screens/runlist.ts";
import { appendRunLog } from "../src/runs/log.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const SESSION = "S3SSION-4f2a";
const NODE = "node-7b-pool";

let dataDir: string;
let app: App;
let http: ForgeHttp;
const token: Record<string, string> = {};
const runs: Record<string, string> = {};
const users: Record<string, User> = {};
let open: Repo;

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

async function get(path: string, who?: string) {
  const res = await http.handle(
    new Request(`http://forge.test${path}`, {
      headers: who === undefined ? {} : { authorization: `Bearer ${token[who]}` },
    }),
  );
  return { status: res.status, text: await res.text() };
}

const user = async (username: string, adminIfFirst = false): Promise<User> =>
  ok(
    await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst,
    }),
  );

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-runs-stranger-"));
  app = createApp({ dataDir, port: 0 });
  http = forgeHttp(app);
  const alice = await user("alice", true);
  const mallory = await user("mallory");
  users.alice = alice;
  users.mallory = mallory;
  token.alice = createToken(app.db, alice.id, "t", "ro").token;
  token.mallory = createToken(app.db, mallory.id, "t", "ro").token;
  for (const [name, visibility] of [["open", "public"], ["closed", "private"]] as const) {
    const repo = ok(await createRepo(app, alice, { name, visibility }));
    ok(
      await commitToBranch(app, alice, repo, {
        message: "Start",
        files: [{ path: "README.md", content: `# ${name}\n` }],
      }),
    );
    const run = createRun(app.db, { repoId: repo.id, kind: "agent", actorId: alice.id, reason: "assigned" });
    claimRun(app.db, run.id);
    noteRunProgress(app.db, run.id, { sessionId: SESSION, costUsd: 1.25, placement: "job", node: NODE });
    appendRunLog(dataDir, run.id, "a line of the transcript");
    finishRun(app.db, run.id, { state: "ok", summary: `${name} done`, sessionId: SESSION, costUsd: 1.25, turns: 9 });
    runs[name] = run.id;
  }
  // The public repository is an app with a run under way, so MCP `now`
  // (which lists apps' live runs) has one to answer about.
  open = getRepo(app.db, "alice", "open")!;
  ok(insertApp(app.db, { repoId: open.id, slug: "open", access: "public" }));
  const live = createRun(app.db, { repoId: open.id, kind: "agent", actorId: alice.id, reason: "assigned" });
  claimRun(app.db, live.id);
  noteRunProgress(app.db, live.id, { sessionId: SESSION, costUsd: 0.5, placement: "job", node: NODE });
  runs.live = live.id;
}, 60_000);

async function now(who: string): Promise<Record<string, unknown>[]> {
  const res = await http.handle(
    new Request("http://forge.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token[who]}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "now", arguments: {} } }),
    }),
  );
  expect(res.status).toBe(200);
  const answer = (await res.json()) as { result: { content: { text: string }[] } };
  return JSON.parse(answer.result.content[0]!.text) as Record<string, unknown>[];
}

afterAll(async () => {
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("runs a stranger reads", () => {
  test("a public repository's runs say what ran, never its session, node or cost", async () => {
    for (const who of [undefined, "mallory"]) {
      for (const path of ["/api/v1/repos/alice/open/runs", `/api/v1/repos/alice/open/runs/${runs.open}`]) {
        const res = await get(path, who);
        expect(res.status).toBe(200);
        expect(res.text).toContain("open done");
        expect(res.text).not.toContain(SESSION);
        expect(res.text).not.toContain(NODE);
        const body = JSON.parse(res.text) as { items?: Record<string, unknown>[] } & Record<string, unknown>;
        const run = body.items?.[0] ?? body;
        expect([run["costUsd"], run["turns"], run["sessionId"], run["node"]]).toEqual([0, 0, "", ""]);
      }
    }
  });

  test("its owner reads all of it", async () => {
    const res = await get(`/api/v1/repos/alice/open/runs/${runs.open}`, "alice");
    const run = JSON.parse(res.text) as Record<string, unknown>;
    expect([run["costUsd"], run["turns"], run["sessionId"], run["node"]]).toEqual([1.25, 9, SESSION, NODE]);
  });

  test("a private repository's runs are a 404 to a stranger, and the same 404 as no repository", async () => {
    const missing = await get("/api/v1/repos/alice/nothing-here/runs");
    expect(missing.status).toBe(404);
    for (const who of [undefined, "mallory"]) {
      for (const path of [
        "/api/v1/repos/alice/closed/runs",
        `/api/v1/repos/alice/closed/runs/${runs.closed}`,
        `/api/v1/repos/alice/closed/runs/${runs.closed}/log`,
      ]) {
        const res = await get(path, who);
        expect(res.status).toBe(404);
        expect(res.text).toBe(missing.text);
      }
    }
    expect((await get("/api/v1/repos/alice/closed/runs", "alice")).status).toBe(200);
  });

  test("the run page shows a stranger no node", async () => {
    const res = await get(`/alice/open/runs/${runs.open}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("open done");
    expect(res.text).not.toContain(NODE);
  });

  test("MCP now tells a stranger no node or cost, and the owner both", async () => {
    const theirs = (await now("mallory")).find((r) => r["run"] === runs.live);
    expect(theirs).toBeDefined();
    expect(JSON.stringify(theirs)).not.toContain(NODE);
    expect(theirs!["costUsd"]).toBe(0);
    const own = (await now("alice")).find((r) => r["run"] === runs.live);
    expect(own!["ran"]).toBe(`ran as a cluster job on ${NODE}`);
    expect(own!["costUsd"]).toBe(0.5);
  });

  test("the terminal's run rows show a stranger no node or cost, and the owner both", () => {
    const meta = (who: User | undefined) =>
      runRows(ok(listRepoRuns(app, who, open)), new Map()).map((row) => row.meta).join("\n");
    for (const who of [undefined, users.mallory]) {
      const rows = meta(who);
      expect(rows).not.toContain(NODE);
      expect(rows).not.toContain("$");
    }
    expect(meta(users.alice)).toContain(NODE);
    expect(meta(users.alice)).toContain("$1.25");
  });
});
