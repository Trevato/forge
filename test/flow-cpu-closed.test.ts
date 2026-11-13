/**
 * Pulls closed unmerged after a check stopped for CPU (#11904): listed on /flow and by
 * `flow { kind: cpu }`, so a person can queue them again.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/core/repos.ts";
import { CPU_STOP_SUMMARY, createRun } from "../src/core/runs.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { cpuClosedPulls } from "../src/flow/cpu_closed.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { id } from "../src/kernel/id.ts";
import { CPU_RED_LIKE, isCpuStop } from "../src/flow/cpu_stops.ts";
import { cpuStopsSection } from "../src/web/pages/flow-cpu.ts";
import { flowLines } from "../src/tui/screens/flow.ts";
import { cpuStopLines } from "../src/tui/screens/flow_cpu.ts";

const NOW = new Date();
const ago = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const RED_STOP = "check failed: stopped: used 16.3 cores for 31s, over twice its limit of 16; the busiest process is sh";

let dir: string;
let app: App;
let servers: Servers;
let adminTok: string;
let guestTok: string;
let adminCookie = "";
let guestCookie = "";

const signIn = async (username: string): Promise<string> => {
  const res = await fetch(`${servers.url}/signin`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
    body: new URLSearchParams({ username, password: "a-good-passphrase" }),
  });
  return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-cpu-closed-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const mk = async (username: string, first = false) => {
    const u = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst: first });
    if (!u.ok) throw new Error(u.error);
    return u.value;
  };
  const alice = await mk("alice", true);
  const carol = await mk("carol");
  adminTok = createToken(app.db, alice.id, "rw", "rw").token;
  guestTok = createToken(app.db, carol.id, "rw", "rw").token;
  const repo = async (name: string, visibility: "public" | "private") => {
    const x = await createRepo(app.db, app.reposRoot, { ownerId: alice.id, name, visibility, description: name });
    if (!x.ok) throw new Error(x.error);
    return x.value;
  };
  const pub = await repo("engine", "public");
  const priv = await repo("vault", "private");
  let n = 0;
  /**
   * A pull closed `closedMins` ago (merged or not) whose checks ended as `checks` say, oldest
   * first.
   */
  const pull = (r: typeof pub, closedMins: number, merged: boolean, checks: [state: string, summary: string][]) => {
    const issueId = id();
    n++;
    app.db
      .query(`INSERT INTO issue (id, repo_id, number, kind, title, author_id, state, created_at, closed_at) VALUES (?1, ?2, ?3, 'pull', 'P', ?4, 'closed', ?5, ?6)`)
      .run(issueId, r.id, n, alice.id, ago(closedMins + 60), ago(closedMins));
    app.db
      .query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id, merged_at) VALUES (?1, 'main', ?2, '', '', ?3, ?4)`)
      .run(issueId, `b/${n}`, r.id, merged ? ago(closedMins) : null);
    checks.forEach(([state, summary], k) => {
      const run = createRun(app.db, { repoId: r.id, kind: "check", issueId, attempt: k });
      app.db.query(`UPDATE run SET state = ?2, summary = ?3, finished_at = ?4 WHERE id = ?1`).run(run.id, state, summary, ago(closedMins + checks.length - k));
    });
    return n;
  };
  // Stopped for CPU, queued again, then closed: the close cancelled the retry.
  pull(pub, 30, false, [["cancelled", CPU_STOP_SUMMARY], ["cancelled", "pull closed"]]);
  // Stopped for CPU too, but it landed.
  pull(pub, 20, true, [["cancelled", CPU_STOP_SUMMARY], ["cancelled", "pull landed"]]);
  // Red for its own reason and closed.
  pull(pub, 10, false, [["failed", "check failed: test/a.test.ts failed"]]);
  // Stopped once, then red for its own reason: its last check is not a stop.
  pull(pub, 15, false, [["cancelled", CPU_STOP_SUMMARY], ["failed", "check failed: test/b.test.ts failed"]]);
  // A second stop reported red, closed later, in a private repository.
  pull(priv, 5, false, [["cancelled", CPU_STOP_SUMMARY], ["failed", RED_STOP]]);
  adminCookie = await signIn("alice");
  guestCookie = await signIn("carol");
}, 60_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("cpuClosedPulls", () => {
  test("lists only the pulls closed unmerged whose last check was a CPU stop, newest close first", () => {
    expect(cpuClosedPulls(app.db, NOW).map((p) => `${p.repo}#${p.number}`)).toEqual(["alice/vault#5", "alice/engine#1"]);
    expect(cpuClosedPulls(app.db, NOW, { publicOnly: true }).map((p) => p.number)).toEqual([1]);
    expect(cpuClosedPulls(app.db, NOW, { cap: 1 }).map((p) => p.number)).toEqual([5]);
  });

  test("the cap counts CPU stops only: a newer close red for its own reason does not take the one place", () => {
    // #3 (red for its own reason) closed after #1; with one place, #1 still fills it.
    expect(cpuClosedPulls(app.db, NOW, { cap: 1, publicOnly: true }).map((p) => p.number)).toEqual([1]);
  });

  test("the SQL pattern and isCpuStop agree on the red forms", () => {
    const like = new RegExp(`^${CPU_RED_LIKE.split("%").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "s");
    for (const s of [RED_STOP, "check failed: stopped: it used 4 cores for 12s, over its limit of 2", "check failed: test/a.test.ts failed", "stopped: by hand"]) {
      expect(like.test(s)).toBe(isCpuStop("failed", s));
    }
  });

  test("the clock is passed in: a week later the stops have left the window, and before the close nothing is closed", () => {
    expect(cpuClosedPulls(app.db, new Date(NOW.getTime() + 8 * 24 * 3_600_000))).toEqual([]);
    expect(cpuClosedPulls(app.db, new Date(NOW.getTime() - 7 * 60_000)).map((p) => p.number)).toEqual([1]);
  });
});

describe("/flow's block", () => {
  test("one count line, then one row per pull with its close time; draws nothing when both are empty", () => {
    expect(String(cpuStopsSection(0, []))).toBe("");
    const s = String(cpuStopsSection(2, cpuClosedPulls(app.db, NOW)));
    expect(s).toContain("<p>2 checks stopped for CPU in the last hour; 2 pulls closed unmerged after a CPU stop.</p>");
    expect(s).toContain(`<ul class="list" id="flow-cpu-closed">`);
    expect(s.match(/<li/g)?.length).toBe(2);
    expect(s).toMatch(/<a href="\/alice\/vault\/pulls\/5" class="row"[^>]*>[\s\S]*alice\/vault #5[\s\S]*closed <time datetime=/);
    expect(s).toContain(`<a href="/alice/engine/pulls/1" class="row"`);
    const quietHour = String(cpuStopsSection(0, cpuClosedPulls(app.db, NOW)));
    expect(quietHour).toContain("<p>2 pulls closed unmerged after a CPU stop.</p>");
    expect(quietHour).not.toContain("stopped for CPU in the last hour");
    expect(String(cpuStopsSection(1, []))).not.toContain("flow-cpu-closed");
  });

  test("the page carries it for an admin; anyone else gets no /flow", async () => {
    const admin = await (await fetch(`${servers.url}/flow`, { headers: { cookie: adminCookie } })).text();
    expect(admin).toContain(`id="flow-cpu-closed"`);
    expect(admin).toContain(`href="/alice/vault/pulls/5"`);
    const guest = await fetch(`${servers.url}/flow`, { headers: { cookie: guestCookie } });
    expect(guest.status).toBe(404);
    expect(await guest.text()).not.toContain("flow-cpu-stops");
  });
});

describe("the Flow dialog carries the lines (#11904)", () => {
  test("for a person, and not for an agent reader", () => {
    const person = flowLines(app.db, new Date(), [], undefined, []).join("\n");
    expect(person).toContain("5 checks stopped for CPU in the last hour.");
    expect(person).toContain("  alice/vault #5");
    const agent = flowLines(app.db, new Date(), [], { queues: [] }, []).join("\n");
    expect(agent).not.toContain("stopped for CPU in the last hour.");
    expect(agent).not.toContain("Closed unmerged after a CPU stop");
  });
});

describe("flow { kind: cpu }", () => {
  const call = async (token: string) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "flow", arguments: { kind: "cpu" } } }),
    });
    const body: any = await res.json();
    return JSON.parse(body.result.content[0].text);
  };

  test("returns the same rows: an admin every repository, anyone else public ones", async () => {
    const admin = await call(adminTok);
    expect(admin.closed.map((p: { number: number }) => p.number)).toEqual([5, 1]);
    // #1, #2 and #4 stopped once each, #5 twice (queued again, then red): five in the hour.
    expect(admin.stopped).toBe(5);
    const guest = await call(guestTok);
    expect(guest).toEqual({ stopped: 0, closed: [expect.objectContaining({ repo: "alice/engine", number: 1 })] });
  });
});

describe("the Flow dialog's CPU-stop lines (#11904)", () => {
  test("quiet says nothing", () => {
    expect(cpuStopLines(0, [], 58)).toEqual([]);
  });

  test("the hour's count, then one line per closed pull", () => {
    const lines = cpuStopLines(2, [{ repo: "ada/notes", number: 7, closedAt: "2026-11-12T10:00:00.000Z" }], 58);
    expect(lines).toEqual(["", "2 checks stopped for CPU in the last hour.", "Closed unmerged after a CPU stop, to queue again:", "  ada/notes #7"]);
  });

  test("pulls without a stop this hour drop the count", () => {
    expect(cpuStopLines(0, [{ repo: "ada/notes", number: 7, closedAt: "x" }], 58)).toEqual(["", "Closed unmerged after a CPU stop, to queue again:", "  ada/notes #7"]);
  });
});
