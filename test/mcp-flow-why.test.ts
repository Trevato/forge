/** `flow` with a repository, issue or pull answers the first gate that holds it, from the one list in flow/why.ts. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { holdFile } from "../src/crew/file_holds.ts";
import { addDependency } from "../src/core/dependencies.ts";
import { getPull } from "../src/core/pulls.ts";
import { setIssueState, createIssue, type Issue } from "../src/core/issues.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { movingRow } from "../src/tui/screens/about.ts";
import { CAUSES, firstCause, type WhyFacts } from "../src/flow/why.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";

describe("the list of causes", () => {
  const cases: [string, WhyFacts][] = [
    ["wall", { actor: "person", wall: ["anyone signed out could read pack records"] }],
    ["ceiling", { actor: "builder", ceilingUsd: 20 }],
    ["hot_file", { actor: "builder", hotFile: "src/a.ts is in 3 open pulls" }],
    ["blocked_by", { actor: "builder", blockedBy: [4, 9] }],
    ["later_gate", { actor: "builder", laterGate: "behind the Later gate" }],
    ["no_builder", { actor: "builder", builders: 0 }],
    ["no_headroom", { actor: "builder", noHeadroom: true }],
    ["red_check", { actor: "builder", redCheck: true }],
    ["waiting_review", { actor: "reviewer", waitingReview: true }],
  ];
  for (const [name, facts] of cases)
    test(`${name} answers its gate, with a sentence and the action that clears it`, () => {
      const cause = firstCause(facts);
      expect(cause?.name).toBe(name as never);
      expect(cause?.says.length).toBeGreaterThan(10);
      expect(cause?.clears.length).toBeGreaterThan(10);
    });

  test("every cause in the list has a case, and the first in order wins", () => {
    expect(cases.map(([n]) => n)).toEqual([...CAUSES]);
    expect(firstCause({ actor: "builder", noHeadroom: true, redCheck: true })?.name).toBe("no_headroom");
    expect(firstCause({ actor: "queue" })).toBeNull();
    // A ceiling does not hold a pull that only waits for the queue.
    expect(firstCause({ actor: "queue", ceilingUsd: 5 })).toBeNull();
  });
});

describe("MCP flow with a subject", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let ownerTok: string;
  let readerTok: string;
  let plain: Issue;
  let blocked: Issue;
  let alice: User;
  let carol: User;
  let repo: Repo;
  let id = 1;
  const issueOf = (title: string) => {
    const i = createIssue(app.db, { repoId: repo.id, authorId: alice.id, title });
    if (!i.ok) throw new Error(i.error);
    return i.value;
  };

  const call = async (token: string, args: unknown) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: "flow", arguments: args } }),
    });
    const body: any = await res.json();
    const text: string = body.result.content[0].text;
    return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-flow-why-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const mk = async (username: string, first = false) => {
      const u = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: first,
      });
      if (!u.ok) throw new Error(u.error);
      promote(app.db, u.value);
      return u.value;
    };
    alice = await mk("alice", true);
    carol = await mk("carol");
    ownerTok = createToken(app.db, alice.id, "rw", "rw").token;
    readerTok = createToken(app.db, carol.id, "rw", "rw").token;
    const made = await createRepo(app, alice, { name: "one", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const mkIssue = issueOf;
    plain = mkIssue("plain");
    const blocker = mkIssue("blocker");
    blocked = mkIssue("blocked");
    addDependency(app.db, blocked, blocker, alice.id);
    const bot = await createAgent(app, alice, { username: "bot" });
    if (!bot.ok) throw new Error(String(bot.error));
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("with no arguments it is the pipeline, for an admin only", async () => {
    expect((await call(ownerTok, {})).value.stages).toBeDefined();
    expect((await call(readerTok, {})).error).toContain("only an admin");
  });

  test("a repository with no builder says so", async () => {
    const r = await call(ownerTok, { repo: "alice/one" });
    expect(r.value).toMatchObject({ subject: "alice/one", moving: false, cause: "no_builder" });
  });

  test("an issue behind another names it; a free one moves once a builder is on the crew", async () => {
    const r = await call(ownerTok, { repo: "alice/one", issue: blocked.number });
    expect(r.value).toMatchObject({ moving: false, cause: "blocked_by" });
    expect(r.value.says).toContain("#2");
    const repo = getRepo(app.db, "alice", "one")!;
    const alice = getUserByName(app.db, "alice")!;
    expect(addToCrew(app, alice, repo, "bot").ok).toBe(true);
    const free = await call(ownerTok, { repo: "alice/one", issue: plain.number });
    expect(free.value).toMatchObject({ moving: true });
  });

  test("a reader is refused, and bad numbers are invalid", async () => {
    expect((await call(readerTok, { repo: "alice/one", issue: 1 })).error).toContain("can write");
    expect((await call(ownerTok, { repo: "alice/one", issue: "x" })).error).toContain("numbers");
    expect((await call(ownerTok, { repo: "alice/one", issue: 1, pull: 2 })).error).toContain("not both");
    expect((await call(ownerTok, { repo: "alice/one", issue: 99 })).error).toContain("no issue");
  });

  test("a closed issue is closed, not moving", async () => {
    const done = issueOf("done");
    expect(setIssueState(app.db, done.id, "closed")).toBeDefined();
    const r = await call(ownerTok, { repo: "alice/one", issue: done.number });
    expect(r.value).toMatchObject({ moving: false, state: "closed" });
    expect(r.value.cause).toBeUndefined();
  });

  test("an issue naming a file an admin holds is held by hot_file", async () => {
    const pinned = issueOf("Change src/pinned.ts");
    expect(holdFile(app.db, repo.id, "src/pinned.ts", "alice").ok).toBe(true);
    const r = await call(ownerTok, { repo: "alice/one", issue: pinned.number });
    expect(r.value).toMatchObject({ moving: false, cause: "hot_file" });
    expect(JSON.stringify(r.value)).toContain("An admin holds new work on src/pinned.ts");
    expect(r.value.says).toContain("src/pinned.ts");
  });

  test("an issue filed under Later is held by later_gate, not blocked_by", async () => {
    const gate = issueOf("Later gate: not yet");
    const umbrella = issueOf("Later: someday");
    const filed = issueOf("Someday thing");
    void gate;
    addDependency(app.db, umbrella, filed, alice.id);
    const r = await call(ownerTok, { repo: "alice/one", issue: filed.number });
    expect(r.value).toMatchObject({ moving: false, cause: "later_gate" });
  });

  test("the terminal's About card carries the same first gate for a writer, and none for a reader", () => {
    expect(movingRow({ app, user: alice } as never, getRepo(app.db, "alice", "one"))).toEqual([["Moving", "yes"]]);
    expect(movingRow({ app, user: carol } as never, getRepo(app.db, "alice", "one"))).toEqual([]);
  });
});

describe("MCP flow about a pull", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let tok: string;
  let alice: User;
  let repo: Repo;
  let id = 1;

  const call = async (args: unknown) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${tok}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: "flow", arguments: args } }),
    });
    const body: any = await res.json();
    return JSON.parse(body.result.content[0].text);
  };
  const put = async (branch: string, content: string) => {
    const done = await commitToBranch(app, alice, repo, {
      branch,
      message: `edit ${branch}`,
      files: [{ path: "code.txt", content }],
    });
    if (!done.ok) throw new Error(JSON.stringify(done.error));
  };
  const pullOn = async (branch: string) => {
    await put(branch, `top\nbase\n${branch}\n`);
    const opened = await openPull(app, alice, repo, { title: branch, baseBranch: "main", headBranch: branch });
    if (!opened.ok) throw new Error(String(opened.error));
    return opened.value.number;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-flow-pull-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    servers = await serve(app);
    const u = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!u.ok) throw new Error(u.error);
    alice = u.value;
    tok = createToken(app.db, alice.id, "rw", "rw").token;
    const made = await createRepo(app, alice, { name: "lib", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    await put("main", "top\nbase\n");
    const bot = await createAgent(app, alice, { username: "bot" });
    if (!bot.ok) throw new Error(String(bot.error));
    expect(addToCrew(app, alice, repo, "bot").ok).toBe(true);
  }, 60_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an unreviewed pull waits for a review and says who acts next", async () => {
    const n = await pullOn("wait");
    const r = await call({ repo: "alice/lib", pull: n });
    expect(r).toMatchObject({ subject: `alice/lib!${n}`, moving: false, cause: "waiting_review", next: { who: "reviewer" } });
  });

  test("a red check on the head git has now is red_check, whatever head is stored", async () => {
    const n = await pullOn("red");
    const live = getPull(app.db, repo.id, n)!.headOid;
    const run = createRun(app.db, { repoId: repo.id, kind: "check", issueId: getPull(app.db, repo.id, n)!.id, env: `pull-${n}`, commitOid: live });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, { state: "failed", summary: "boom" });
    // The stored head falls behind the branch: the answer reads the branch.
    app.db.query("UPDATE pull SET head_oid = ?2 WHERE issue_id = ?1").run(getPull(app.db, repo.id, n)!.id, "0".repeat(40));
    const r = await call({ repo: "alice/lib", pull: n });
    expect(r).toMatchObject({ moving: false, cause: "red_check", next: { who: "builder" } });
  });

  test("a walled pull, approved and green, is not moving and not the queue's (#7847)", async () => {
    const n = await pullOn("walled");
    const p = getPull(app.db, repo.id, n)!;
    const live = p.headOid;
    const run = createRun(app.db, { repoId: repo.id, kind: "check", issueId: p.id, env: `pull-${n}`, commitOid: live });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, { state: "ok", summary: "green" });
    const bot = { id: alice.id };
    app.db.run(
      "INSERT INTO review (id, issue_id, author_id, state, commit_oid, created_at) VALUES ('rvw', ?1, ?2, 'approved', ?3, ?4)",
      [p.id, bot.id, live, new Date().toISOString()],
    );
    // Before the wall speaks it reads as the queue's, as it always did.
    expect(await call({ repo: "alice/lib", pull: n })).toMatchObject({ next: { who: "queue" } });
    app.db.run(
      "INSERT INTO decision (id, kind, repo_id, issue_id, state, answer, p, by, ms) VALUES ('dw', 'land', ?1, ?2, ?3, 'wall', 1, 'wall', 0)",
      [repo.id, p.id, JSON.stringify({ head: live, cells: ["pack.read as anon: new, and yes"], plain: ["anyone signed out could read pack records"] })],
    );
    const r = await call({ repo: "alice/lib", pull: n });
    expect(r).toMatchObject({ moving: false, cause: "wall", next: { who: "person" } });
    expect(r.says).toContain("anyone signed out could read pack records");
    expect(r.next.why).toContain("anyone signed out could read pack records");
    // A push is a new head: the wall's word is about the old one.
    app.db.query("UPDATE pull SET head_oid = ?2 WHERE issue_id = ?1").run(p.id, "0".repeat(40));
    app.db.run("UPDATE decision SET state = ?1 WHERE id = 'dw'", [JSON.stringify({ head: "1".repeat(40), cells: [], plain: [] })]);
    expect((await call({ repo: "alice/lib", pull: n })).cause).not.toBe("wall");
  });

  test("a merged pull is merged and a closed one is closed, neither moving", async () => {
    const m = getPull(app.db, repo.id, await pullOn("gone"))!;
    app.db.query("UPDATE pull SET merged_at = ?2 WHERE issue_id = ?1").run(m.id, new Date().toISOString());
    expect(await call({ repo: "alice/lib", pull: m.number })).toMatchObject({ moving: false, state: "merged" });
    const c = getPull(app.db, repo.id, await pullOn("shut"))!;
    app.db.query("UPDATE issue SET state = 'closed' WHERE id = ?1").run(c.id);
    expect(await call({ repo: "alice/lib", pull: c.number })).toMatchObject({ moving: false, state: "closed" });
  });
});
