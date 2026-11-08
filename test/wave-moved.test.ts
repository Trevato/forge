/** A wave says which milestones it moved, each with how far along it is now. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkIssue } from "../src/actions/dependencies.ts";
import { openIssue } from "../src/actions/issues.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { getIssueById, setIssueState, type Issue } from "../src/core/issues.ts";
import { readPlan } from "../src/core/milestones.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { movedForViewer, movedMilestones } from "../src/story/wave_moved.ts";
import { mergedPull, waveNaming } from "./helpers/wave-pulls.ts";

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

describe("wave moved", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let cookie: string;
  let repo: Repo;
  let milestone: Issue;
  let a: Issue;
  let b: Issue;
  let c: Issue;
  let loose: Issue;
  const fresh = () => getRepoById(app.db, repo.id)!;
  const open = (title: string): Issue =>
    must(openIssue(app, alice, fresh(), { title }));
  const link = (waiter: Issue, on: Issue): void => {
    must(
      linkIssue(app, alice, fresh(), getIssueById(app.db, waiter.id)!, getIssueById(app.db, on.id)!),
    );
  };
  const closing = async (title: string, closes: Issue): Promise<number> => {
    const n = await mergedPull(app, alice, repo, title);
    app.db
      .query("UPDATE issue SET body = ? WHERE repo_id = ? AND number = ?")
      .run(`Closes #${closes.number}`, repo.id, n);
    return n;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-wave-moved-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    alice = must(
      await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username: "alice",
        email: "alice@f.dev",
        password: "a-good-passphrase",
        adminIfFirst: true,
      }),
    );
    cookie = `forge_session=${createSession(app.db, alice.id).token}; forge_mode=dev`;
    repo = must(await createRepo(app, alice, { name: "plan", visibility: "public" }));
    must(await commitToBranch(app, alice, repo, { message: "init", files: [{ path: "README.md", content: "hi\n" }] }));
    milestone = open("Ship the thing");
    a = open("Part A");
    b = open("Part B");
    c = open("Part C");
    loose = open("Unrelated");
    for (const part of [a, b, c]) link(milestone, part);
    for (const done of [a, b]) setIssueState(app.db, done.id, "closed", "done");
  }, 60_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("two pulls under one milestone, one under none: exactly that milestone, with counts", () => {
    const plan = readPlan(app.db, fresh(), { spend: false });
    const moved = movedMilestones({
      pulls: [1, 2, 3],
      closes: new Map([[1, [a.number]], [2, [b.number]], [3, [loose.number]]]),
      plan,
    });
    expect(moved).toEqual([
      { number: milestone.number, title: "Ship the thing", done: 2, total: 3 },
    ]);
  });

  test("a wave that closed nothing under a milestone moved none", () => {
    const plan = readPlan(app.db, fresh(), { spend: false });
    expect(movedMilestones({ pulls: [3], closes: new Map([[3, [loose.number]]]), plan })).toEqual([]);
    expect(movedMilestones({ pulls: [], closes: new Map(), plan })).toEqual([]);
  });

  test("the wave page lists the Moved milestone, linked; none when it moved none", async () => {
    const p1 = await closing("Part A work", a);
    const p2 = await closing("Part B work", b);
    const p3 = await closing("Loose work", loose);
    const ref = (number: number) => ({ owner: "alice", name: "plan", number });
    must(
      await commitToBranch(app, alice, fresh(), {
        message: "waves",
        files: [
          { path: "waves/0.1.0.md", content: waveNaming("0.1.0", [ref(p1), ref(p2), ref(p3)]) },
          { path: "waves/0.2.0.md", content: waveNaming("0.2.0", [ref(p3)]) },
        ],
      }),
    );
    const text = await (await fetch(`${servers.url}/alice/plan/waves/0.1.0`, { headers: { cookie } })).text();
    expect(text).toContain("<h2>Moved</h2>");
    expect(text).toContain(`href="/alice/plan/milestones/${milestone.number}"`);
    expect(text).toContain("Ship the thing");
    expect(text).toContain("2 of 3 done");
    const none = await (await fetch(`${servers.url}/alice/plan/waves/0.2.0`, { headers: { cookie } })).text();
    expect(none).not.toContain("Moved");
  });

  const wave = async (version: string, numbers: number[]): Promise<string> => {
    must(
      await commitToBranch(app, alice, fresh(), {
        message: `wave ${version}`,
        files: [
          {
            path: `waves/${version}.md`,
            content: waveNaming(version, numbers.map((number) => ({ owner: "alice", name: "plan", number }))),
          },
        ],
      }),
    );
    return `${servers.url}/alice/plan/waves/${version}`;
  };

  test("a milestone the viewer may not see is not named: a guest sees none, a writer sees it", async () => {
    const secret = must(openIssue(app, alice, fresh(), { title: "Sealed goal", sealed: true }));
    const part = open("Sealed part");
    link(secret, part);
    setIssueState(app.db, part.id, "closed", "done");
    const url = await wave("0.3.0", [await closing("Sealed part work", part)]);
    const guest = await (await fetch(url)).text();
    expect(guest).not.toContain("Sealed goal");
    expect(guest).not.toContain("<h2>Moved</h2>");
    // The plan itself leaves sealed issues out, for everyone.
    const owner = await (await fetch(url, { headers: { cookie } })).text();
    expect(owner).not.toContain("Sealed goal");
  });

  test("the viewer gate holds even if a plan carried a sealed milestone: a guest loses it, a writer keeps it", async () => {
    const goal = open("Gate goal");
    const part = open("Gate part");
    link(goal, part);
    setIssueState(app.db, part.id, "closed", "done");
    const n = await closing("Gate work", part);
    const real = readPlan(app.db, fresh(), { spend: false });
    const issues = real.read.graph.issues.map((i) => (i.id === goal.id ? { ...i, sealed: true } : i));
    const plan = { ...real, read: { ...real.read, graph: { ...real.read.graph, issues } } } as typeof real;
    const ask = (viewer: User | undefined) =>
      movedForViewer({ db: app.db, repo: fresh(), refs: [{ owner: "alice", name: "plan", number: n }], viewer, plan: () => plan });
    expect(ask(undefined)).toEqual([]);
    expect(ask(alice).map((m) => m.title)).toEqual(["Gate goal"]);
  });

  test("a pull that was closed and not merged moved nothing", async () => {
    const goal = open("Closed-pull goal");
    const part = open("Closed-pull part");
    link(goal, part);
    const n = await closing("Abandoned work", part);
    app.db.query("UPDATE pull SET merged_at = NULL WHERE issue_id = (SELECT id FROM issue WHERE repo_id = ? AND number = ?)").run(repo.id, n);
    app.db.query("UPDATE issue SET state = 'closed' WHERE repo_id = ? AND number = ?").run(repo.id, n);
    const text = await (await fetch(await wave("0.4.0", [n]), { headers: { cookie } })).text();
    expect(text).not.toContain("Closed-pull goal");
    expect(text).not.toContain("<h2>Moved</h2>");
  });
});
