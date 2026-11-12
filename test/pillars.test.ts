/**
 * Pillars: every issue carries the one it serves. An umbrella a writer
 * opened names a pillar and a stranger's names nothing; an issue an
 * umbrella waits for serves that pillar and carries its label, made on
 * first use — by a link, by a plan, by a split, and at boot for what was
 * linked before — and one behind the Later gate carries `Later`; the map
 * counts open work by pillar and reads "no pillar" for the rest; the board
 * and the map's data count the week's merged pulls by pillar.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { linkIssue, unlinkIssue } from "../src/actions/dependencies.ts";
import { openIssue, setIssueState } from "../src/actions/issues.ts";
import { syncAllPillars } from "../src/actions/pillars.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import {
  commitToBranch,
  createLabel,
  createRepo,
} from "../src/actions/repos.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import {
  addDependency,
  dependenciesOf,
  readyNow,
  repoGraph,
} from "../src/core/dependencies.ts";
import {
  getIssueById,
  getLabel,
  labelsFor,
  listIssues,
  listLabels,
  setIssueLabels,
  type Issue,
} from "../src/core/issues.ts";
import { pillarsOf, pillarView } from "../src/core/pillars.ts";
import { askToLiveFor } from "../src/web/ask_to_live.ts";
import { getRepoById, updateRepoSettings, type Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("pillars", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let alice: User;
  let bob: User;
  let mason: User;
  let repo: Repo;
  let cookie: string;
  let rw: string;
  let trust: Issue;
  let feed: Issue;
  let later: Issue;
  let gate: Issue;
  let spam: Issue;
  /** Work, named as the tests file it. */
  let sandbox: Issue;
  let review: Issue;
  let deferred: Issue;
  let waiting: Issue;
  let loose: Issue;
  let composer: Issue;
  let slider: Issue;
  let footer: Issue;
  let parts: Issue[];
  let synced: Issue;

  const fresh = () => getRepoById(app.db, repo.id)!;
  const current = (issue: Issue) => getIssueById(app.db, issue.id)!;
  const names = (issue: Issue) => labelsFor(app.db, issue.id).map((l) => l.name);
  const issue = (title: string, by: User = alice): Issue => {
    const opened = openIssue(app, by, fresh(), { title });
    if (!opened.ok) throw new Error(String(opened.error));
    return opened.value;
  };
  const link = (waiter: Issue, on: Issue, by: User = alice) =>
    linkIssue(app, by, fresh(), current(waiter), current(on));
  const unlink = (waiter: Issue, on: Issue) =>
    unlinkIssue(app, alice, fresh(), current(waiter), current(on));
  const events = (kind: string): number =>
    app.db
      .query<{ n: number }, [string, string]>(
        "SELECT COUNT(*) AS n FROM event WHERE repo_id = ?1 AND kind = ?2",
      )
      .get(repo.id, kind)!.n;
  const get = async (path: string): Promise<string> =>
    (await fetch(`${base}${path}`, { headers: { cookie } })).text();
  const api = async (path: string): Promise<any> =>
    (
      await fetch(`${base}${path}`, {
        headers: { authorization: `Bearer ${rw}` },
      })
    ).json();
  let nextId = 1;
  /** An MCP tool's answer: its JSON value, or its error text. */
  const tool = async (name: string, args: unknown) => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${rw}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: nextId++,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const body = (await res.json()) as any;
    const text: string = body.result.content[0].text;
    return body.result.isError === true
      ? { error: text }
      : { value: JSON.parse(text) };
  };
  /** A pull that closes an issue (or none), landed on main. */
  const land = async (name: string, closes: Issue | null): Promise<string> => {
    const branch = await commitToBranch(app, alice, fresh(), {
      branch: `feature/${name}`,
      base: "main",
      message: name,
      files: [{ path: `${name}.md`, content: `${name}\n` }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, fresh(), {
      title: `Land ${name}`,
      body: closes === null ? "No issue." : `Closes #${closes.number}`,
      baseBranch: "main",
      headBranch: `feature/${name}`,
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const merged = await mergePull(app, alice, fresh(), opened.value, "squash");
    if (!merged.ok) throw new Error(JSON.stringify(merged.error));
    return opened.value.id;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-pillars-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    for (const [username, adminIfFirst] of [
      ["alice", true],
      ["bob", false],
    ] as const) {
      const made = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst,
      });
      if (!made.ok) throw new Error(made.error);
    }
    alice = getUserByName(app.db, "alice")!;
    bob = getUserByName(app.db, "bob")!;
    // Public, so a stranger can open an issue with an umbrella's title.
    const made = await createRepo(app, alice, {
      name: "engine",
      visibility: "public",
    });
    if (!made.ok) throw new Error(String(made.error));
    // These plans open issues: plans need a nod is off (test/plan-route.test.ts covers on).
    repo = updateRepoSettings(app.db, made.value, { plansNeedNod: false });
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "# engine\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const record = insertApp(app.db, {
      repoId: repo.id,
      slug: "engine",
      access: "private",
    });
    if (!record.ok) throw new Error(record.error);
    const agent = await createAgent(app, alice, { username: "mason" });
    if (!agent.ok) throw new Error(String(agent.error));
    expect(addToCrew(app, alice, repo, "mason").ok).toBe(true);
    mason = getUserByName(app.db, "mason")!;
    cookie = (
      (
        await fetch(`${base}/signin`, {
          method: "POST",
          body: new URLSearchParams({
            username: "alice",
            password: "a-good-passphrase",
          }),
          redirect: "manual",
        })
      ).headers.get("set-cookie") ?? ""
    ).split(";")[0]!;
    rw = createToken(app.db, alice.id, "rw", "rw").token;

    // A stranger's issues, titled like umbrellas and older than the real ones.
    spam = issue("P9 Spam: hello", bob);
    issue("P0 Trust: mine now", bob);
    issue("Later gate: mine too", bob);
    trust = issue("P0 Trust: agents contained, every agent pull reviewed");
    feed = issue("P1 Feed: one front door");
    later = issue("Later: work that serves no pillar now");
    gate = issue("Later gate: nothing behind this starts until it is opened");
    // An order between pillars, and the gate behind them: not membership.
    expect(link(feed, trust).ok).toBe(true);
    expect(link(gate, trust).ok).toBe(true);
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an umbrella a writer opened names a pillar, in order; a stranger's names nothing, and is no gate", () => {
    const set = pillarsOf(app.db, fresh());
    expect(set.pillars.map((p) => [p.name, p.umbrella.number])).toEqual([
      ["P0 Trust", trust.number],
      ["P1 Feed", feed.number],
    ]);
    expect(set.gate?.number).toBe(gate.number);
    expect(set.later?.number).toBe(later.number);
  });

  test("linked under an umbrella, an issue carries the pillar's label, made on first use; unlinked, it does not", () => {
    expect(listLabels(app.db, repo.id)).toEqual([]);
    sandbox = issue("Sandbox every run");
    expect(link(trust, sandbox).ok).toBe(true);
    expect(names(sandbox)).toEqual(["P0 Trust"]);
    expect(getLabel(app.db, repo.id, "P0 Trust")?.color).toMatch(/^[0-9a-f]{6}$/);
    // Said, as a person's own labelling is: the label once, the issue each time.
    expect(events("label.created")).toBe(1);
    expect(events("issue.labeled")).toBe(1);
    review = issue("Review every agent pull");
    expect(link(trust, review).ok).toBe(true);
    expect(names(review)).toEqual(["P0 Trust"]);
    expect(events("label.created")).toBe(1);
    // The umbrellas and the gate are the plan's furniture: under nothing.
    expect(names(trust)).toEqual([]);
    expect(names(gate)).toEqual([]);
    // One pillar an issue: the first in order while it is under two.
    expect(link(feed, sandbox).ok).toBe(true);
    expect(names(sandbox)).toEqual(["P0 Trust"]);
    expect(unlink(trust, sandbox).ok).toBe(true);
    expect(names(sandbox)).toEqual(["P1 Feed"]);
    expect(unlink(feed, sandbox).ok).toBe(true);
    expect(names(sandbox)).toEqual([]);
    expect(link(trust, sandbox).ok).toBe(true);
    expect(names(sandbox)).toEqual(["P0 Trust"]);
    // An issue's other labels are its own.
    const bug = createLabel(app, alice, fresh(), "bug", "d73a4a");
    if (!bug.ok) throw new Error(bug.error);
    setIssueLabels(app.db, review.id, [
      bug.value.id,
      getLabel(app.db, repo.id, "P0 Trust")!.id,
    ]);
    expect(unlink(trust, review).ok).toBe(true);
    expect(names(review)).toEqual(["bug"]);
    expect(link(trust, review).ok).toBe(true);
    expect(names(review)).toEqual(["P0 Trust", "bug"]);
    // Behind the Later gate, an issue reads Later; a pillar outranks it.
    waiting = issue("A fleet table");
    expect(link(waiting, gate).ok).toBe(true);
    expect(names(waiting)).toEqual(["Later"]);
    expect(link(feed, waiting).ok).toBe(true);
    expect(names(waiting)).toEqual(["P1 Feed"]);
    expect(unlink(feed, waiting).ok).toBe(true);
    expect(names(waiting)).toEqual(["Later"]);
  });

  test("the crew's link labels too; a stranger can link nothing, and their umbrella labels nothing", () => {
    deferred = issue("A profit slider");
    expect(link(later, deferred, mason).ok).toBe(true);
    expect(names(deferred)).toEqual(["Later"]);
    loose = issue("Tidy the README");
    const refused = link(trust, loose, bob);
    expect(refused.ok ? "linked" : refused.error).toBe("forbidden");
    expect(names(loose)).toEqual([]);
    expect(link(spam, loose).ok).toBe(true);
    expect(names(loose)).toEqual([]);
    expect(getLabel(app.db, repo.id, "P9 Spam")).toBeUndefined();
  });

  test("a plan's items carry what they were filed under: the pillar's label, or Later", async () => {
    const planned = await tool("plan", {
      app: "alice/engine",
      issues: [
        { key: "composer", title: "A composer above the timeline", pillar: "P1" },
        {
          key: "slider",
          title: "A profit slider",
          later: true,
          why: "Money lines serve no pillar now.",
        },
      ],
    });
    const opened = new Map<string, number>(
      planned.value.opened.map((o: { key: string; number: number }) => [
        o.key,
        o.number,
      ]),
    );
    const byNumber = (n: number) =>
      listIssues(app.db, repo.id, { state: "open", limit: 100 }).find(
        (i) => i.number === n,
      )!;
    composer = byNumber(opened.get("composer")!);
    slider = byNumber(opened.get("slider")!);
    expect(names(composer)).toEqual(["P1 Feed"]);
    expect(
      dependenciesOf(app.db, feed.id).blockedBy.map((i) => i.number),
    ).toContain(composer.number);
    expect(names(slider)).toEqual(["Later"]);
    // Work nobody filed, waiting for the composer.
    footer = issue("Tidy the footer");
    expect(link(footer, composer).ok).toBe(true);
    expect(names(footer)).toEqual([]);
  });

  test("an issue split into parts: the umbrella waits for the parts, and they carry its label", () => {
    parts = [issue("Review: the queue"), issue("Review: the verdict")];
    const split = setIssueState(app, alice, fresh(), current(review), "closed", {
      reason: "split",
      into: parts.map((p) => p.number),
    });
    expect(split.ok).toBe(true);
    const under = dependenciesOf(app.db, trust.id).blockedBy.map((i) => i.number);
    for (const part of parts) {
      expect(under).toContain(part.number);
      expect(names(part)).toEqual(["P0 Trust"]);
    }
  });

  test("at boot, what an umbrella already waited for is labelled, once, and nothing is announced", () => {
    synced = issue("Likes are signals");
    // Linked before pillars had labels: the edge alone.
    expect(addDependency(app.db, current(feed), synced, alice.id).ok).toBe(true);
    expect(names(synced)).toEqual([]);
    const said = events("issue.labeled");
    expect(syncAllPillars(app)).toBe(1);
    expect(names(synced)).toEqual(["P1 Feed"]);
    expect(syncAllPillars(app)).toBe(0);
    // The label only says what the edges say: one set by hand does not stay.
    setIssueLabels(app.db, loose.id, [getLabel(app.db, repo.id, "P0 Trust")!.id]);
    expect(syncAllPillars(app)).toBe(1);
    expect(names(loose)).toEqual([]);
    expect(events("issue.labeled")).toBe(said);
  });

  test("the map counts open work by pillar, links each pillar to its issues, and reads no pillar for the rest", async () => {
    // One of P0's three open issues waits for another.
    expect(link(sandbox, parts[0]!).ok).toBe(true);
    const data = await api("/api/v1/repos/alice/engine/map");
    expect(data.pillars).toEqual([
      { pillar: "P0 Trust", umbrella: trust.number, open: 3, ready: 2, blocked: 1 },
      { pillar: "P1 Feed", umbrella: feed.number, open: 2, ready: 2, blocked: 0 },
      // One under the Later umbrella; two behind the gate. All three are
      // deferred: not ready, and not blocked either — nothing they wait for
      // is the reason.
      { pillar: "Later", umbrella: later.number, open: 3, ready: 0, blocked: 0 },
      // The loose issue, the footer (which waits for the composer), and the
      // stranger's three: one waits for the loose issue, and the other two
      // are a reader's suggestions, open and never ready (`crew/direct.ts`).
      { pillar: null, open: 5, ready: 1, blocked: 2 },
    ]);
    const pillarOf = new Map<number, string | null>(
      data.issues.map((i: { number: number; pillar: string | null }) => [
        i.number,
        i.pillar,
      ]),
    );
    expect(pillarOf.get(sandbox.number)).toBe("P0 Trust");
    expect(pillarOf.get(composer.number)).toBe("P1 Feed");
    expect(pillarOf.get(deferred.number)).toBe("Later");
    expect(pillarOf.get(slider.number)).toBe("Later");
    expect(pillarOf.get(gate.number)).toBeNull();
    expect(pillarOf.get(loose.number)).toBeNull();
    expect(pillarOf.get(spam.number)).toBeNull();
    // An umbrella reads as its own pillar, never as no pillar.
    expect(pillarOf.get(trust.number)).toBe("P0 Trust");
    // The MCP's `map` is the same data.
    const mcp = await tool("map", { app: "alice/engine" });
    expect(mcp.value.pillars).toEqual(data.pillars);
    expect(mcp.value.mergedByPillar).toEqual(data.mergedByPillar);

    const page = await get("/alice/engine/map?view=graph");
    expect(page).toContain('id="map-pillars"');
    // Each pillar opens its milestone (#731).
    expect(page).toMatch(
      new RegExp(
        `href="/alice/engine/milestones/${trust.number}"\\s*>P0 Trust</a`,
      ),
    );
    expect(page).toContain("3 open · 2 ready · 1 blocked");
    expect(page).toMatch(/class="row-title"\s*>no pillar<\/span/);
    expect(page).toMatch(/class="muted small"\s*>3 open · 2 ready · 1 blocked<\/span/);
    const pillarsBlock = page.slice(page.indexOf('id="map-pillars"'), page.indexOf("</section>", page.indexOf('id="map-pillars"')));
    expect(pillarsBlock).not.toContain('class="badge"');
    // The side lists sit straight under their headings, in no card box (#9848).
    expect(pillarsBlock).not.toContain('class="card');
    expect(pillarsBlock).toContain(`href="/alice/engine/issues/${loose.number}"`);
    // A Ready now row leads with its pillar's name.
    const readyBlock = page.slice(page.indexOf("<h2>Ready now</h2>"), page.indexOf("</section>", page.indexOf("<h2>Ready now</h2>")));
    expect(readyBlock).toMatch(/#\d+ · ready · P[01] [A-Za-z]+ · /);
    expect(readyBlock).not.toContain('class="card');
    expect(readyBlock).toContain('href="/alice/engine/issues/');
    // §5's rows draw the section; the old names are gone (#4292).
    expect(page).not.toMatch(/class="[^"]*\bmap-list\b/);
    expect(page).not.toMatch(/class="[^"]*\bmap-empty\b/);
    expect(page).toMatch(/id="map-pillars"[^>]*>\s*<h2>By pillar<\/h2>/);
    expect(page).toContain('data-pillar="P0 Trust"');
    // No rule restyles the card's rows: the list keeps §5's look, and the
    // ask-to-live line stays on the row's one meta line.
    expect(page).not.toMatch(/\.map-pillars\s+ul\b/);
    expect(page).toMatch(/\.map-ask\s*\{\s*display:\s*inline/);
    expect(page).toContain(`href="/alice/engine/issues/${loose.number}"`);
    // The pillar's label narrows the one list.
    const list = await get("/alice/engine/issues?label=P0%20Trust");
    expect(list).toContain("Sandbox every run");
    expect(list).not.toContain("Tidy the README");
  });

  test("merged pulls of the last 7 days count by the pillar of the issue each closes, on the board and in the map's data", async () => {
    await land("sandbox", sandbox);
    await land("queue", parts[0]!);
    await land("composer", composer);
    await land("readme", loose);
    await land("nothing", null);
    const old = await land("verdict", parts[1]!);
    // One instant for the whole case: the merges happened a minute before it
    // however long they took, and the odd one out ten days before, outside
    // the week. The view is read at that instant, not at whatever the clock
    // says by the time the assertions run.
    const T = Date.now();
    const pin = (ago: number, where: string, ...args: string[]) =>
      app.db
        .query(`UPDATE pull SET merged_at = ?1 WHERE ${where}`)
        .run(new Date(T - ago).toISOString(), ...args);
    pin(60_000, "merged_at IS NOT NULL AND issue_id != ?2", old);
    pin(10 * 86_400_000, "issue_id = ?2", old);
    const want = [
      { pillar: "P0 Trust", merged: 2 },
      { pillar: "P1 Feed", merged: 1 },
      { pillar: "Later", merged: 0 },
      { pillar: null, merged: 2 },
    ];
    expect(pillarView(app.db, fresh(), new Date(T))!.merged).toEqual(want);
    const data = await api("/api/v1/repos/alice/engine/map");
    // Nothing has gone live yet, so each pillar's ask-to-live is null: a dash.
    expect(data.mergedByPillar).toEqual({
      days: 7,
      counts: want.map((w) =>
        w.pillar === null ? w : { ...w, askToLive: null },
      ),
    });

    const board = await get("/board");
    expect(board).toMatch(/merged in\s+7 days/);
    expect(board).toContain("P0 Trust <b>2</b>");
    expect(board).toContain("P1 Feed <b>1</b>");
    expect(board).toContain("Later <b>0</b>");
    expect(board).toContain("no pillar <b>2</b>");
    expect(board).toContain(`href="/alice/engine/milestones/${feed.number}"`);
    expect(board).toMatch(
      new RegExp(
        `data-zero="yes"\\s+href="/alice/engine/milestones/${later.number}"`,
      ),
    );
  });

  test("ask-to-live: per pillar, an issue opening to the first production deploy holding the merge of the pull that closed it", async () => {
    // Reads the pulls the test above landed: sandbox and queue for P0 Trust,
    // composer for P1 Feed. Hours are counted back from one instant.
    const T = Date.now();
    const at = (hoursAgo: number) =>
      new Date(T - hoursAgo * 3_600_000).toISOString();
    const pullOf = (title: string) =>
      app.db
        .query<{ id: string; oid: string }, [string]>(
          `SELECT p.issue_id AS id, p.merged_oid AS oid FROM pull p
             JOIN issue i ON i.id = p.issue_id WHERE i.title = ?1`,
        )
        .get(`Land ${title}`)!;
    const sandboxPull = pullOf("sandbox");
    const queuePull = pullOf("queue");
    const composerPull = pullOf("composer");
    expect(queuePull.oid).toMatch(/^[0-9a-f]{40}$/);
    const setCreated = (issue: Issue, hoursAgo: number) =>
      app.db
        .query("UPDATE issue SET created_at = ?1 WHERE id = ?2")
        .run(at(hoursAgo), issue.id);
    const setMerged = (id: string, hoursAgo: number) =>
      app.db
        .query("UPDATE pull SET merged_at = ?1 WHERE issue_id = ?2")
        .run(at(hoursAgo), id);
    setCreated(sandbox, 30);
    setMerged(sandboxPull.id, 20);
    setCreated(parts[0]!, 10);
    setMerged(queuePull.id, 8);
    setMerged(composerPull.id, 6);
    // A deploy and the merged pulls it carries (the `deploy_pull` record).
    const deploy = (
      env: string,
      oid: string,
      state: string,
      hoursAgo: number,
      carries: { id: string; oid: string }[],
    ) => {
      const id = `ask-${nextId++}`;
      app.db
        .query(
          `INSERT INTO run (id, repo_id, kind, env, commit_oid, state, serving_at, finished_at)
           VALUES (?1, ?2, 'deploy', ?3, ?4, ?5, ?6, ?6)`,
        )
        .run(id, repo.id, env, oid, state, at(hoursAgo));
      for (const p of carries)
        app.db
          .query(
            `INSERT INTO deploy_pull (run_id, issue_id, pull_number, merged_oid)
             VALUES (?1, ?2, 0, ?3)`,
          )
          .run(id, p.id, p.oid);
    };
    // A preview and a failed deploy are not production; they count for nothing.
    deploy("pull-9", queuePull.oid, "ok", 19, [sandboxPull, queuePull]);
    deploy("production", composerPull.oid, "failed", 5.5, [composerPull]);
    // Before the merge: it cannot hold it.
    deploy("production", sandboxPull.oid, "ok", 25, [sandboxPull]);
    // The first live deploy holding sandbox's merge: 30h asked, live 12h later.
    // The record, not the commit it ran, says which merges it holds.
    deploy("production", queuePull.oid, "ok", 18, [sandboxPull]);
    // Holds queue's merge, and sandbox's before it: queue was asked 10h ago, live 5h.
    deploy("production", queuePull.oid, "ok", 5, [sandboxPull, queuePull]);
    const view = pillarView(app.db, fresh(), new Date(T))!;
    // The record answers: with no repository on disk, no git can have run.
    const realRoot = app.reposRoot;
    (app as { reposRoot: string }).reposRoot = "/nonexistent";
    const asked = askToLiveFor(app, fresh(), view, alice);
    (app as { reposRoot: string }).reposRoot = realRoot;
    const ask = (name: string) =>
      asked.find((a) => a.pillar === name)!.askToLive;
    // sandbox: 30h -> deploy at 18h ago = 12h; queue: 10h -> 5h ago = 5h.
    expect(ask("P0 Trust")).toEqual({
      medianHours: 8.5,
      slowest: { number: sandbox.number, hours: 12 },
    });
    // composer merged but never live in production.
    expect(ask("P1 Feed")).toBeUndefined();
    expect(ask("Later")).toBeUndefined();

    const data = await api("/api/v1/repos/alice/engine/map");
    const counts = data.mergedByPillar.counts;
    expect(counts[0]).toEqual({
      pillar: "P0 Trust",
      merged: 2,
      askToLive: {
        medianHours: 8.5,
        slowest: { number: sandbox.number, hours: 12 },
      },
    });
    expect(counts[1].askToLive).toBeNull();
    const mcp = await tool("map", { app: "alice/engine" });
    expect(mcp.value.mergedByPillar).toEqual(data.mergedByPillar);
    const limbs = await tool("milestones", { app: "alice/engine" });
    const limb = limbs.value.limbs.find((l: any) => l.number === trust.number);
    expect(limb.askToLive).toEqual(counts[0].askToLive);
    expect(
      limbs.value.limbs.find((l: any) => l.number === feed.number).askToLive,
    ).toBeNull();

    const page = await get("/alice/engine/map?view=graph");
    expect(page).toContain("8.5h median");
    expect(page).toContain(`#${sandbox.number}`);
    expect(page).toMatch(/P1 Feed[\s\S]*?ask to live\s+—/);
  });

  test("ask-to-live leaves out sealed issues for a reader who may not see them", async () => {
    // Continues the test above: sandbox was the slowest at 12h, queue 5h.
    const seal = (sealed: number) =>
      app.db.query("UPDATE issue SET sealed = ?1 WHERE id = ?2").run(sealed, sandbox.id);
    const bobToken = createToken(app.db, bob.id, "ro", "ro").token;
    const asBob = async (path: string) =>
      (await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${bobToken}` } })).json() as Promise<any>;
    const bobTool = async (name: string) => {
      const res = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${bobToken}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: nextId++,
          method: "tools/call",
          params: { name, arguments: { app: "alice/engine" } },
        }),
      });
      const body = (await res.json()) as any;
      return JSON.parse(body.result.content[0].text);
    };
    seal(1);
    try {
      const sealedLink = `/issues/${sandbox.number}"`;
      const guest = await (await fetch(`${base}/alice/engine/map?view=graph`)).text();
      expect(guest).toContain("5h median");
      expect(guest).not.toContain(sealedLink);
      const data = await asBob("/api/v1/repos/alice/engine/map");
      expect(data.mergedByPillar.counts[0].askToLive).toEqual({
        medianHours: 5,
        slowest: { number: parts[0]!.number, hours: 5 },
      });
      expect(JSON.stringify(data)).not.toContain(`"number":${sandbox.number},"hours"`);
      const viaMcp = await bobTool("map");
      expect(viaMcp.mergedByPillar).toEqual(data.mergedByPillar);
      const limbs = await bobTool("milestones");
      expect(
        limbs.limbs.find((l: any) => l.number === trust.number).askToLive.slowest.number,
      ).toBe(parts[0]!.number);
      // A writer still sees it.
      expect(await get("/alice/engine/map?view=graph")).toContain(sealedLink);
      expect(
        (await api("/api/v1/repos/alice/engine/map")).mergedByPillar.counts[0].askToLive
          .slowest.number,
      ).toBe(sandbox.number);
    } finally {
      seal(0);
    }
  });

  test("ask-to-live counts an issue once when two merged pulls close it, at its first time live", async () => {
    // Continues the tests above: the queue pull now also closes sandbox.
    const queueIssue = app.db
      .query<{ id: string; body: string }, []>(
        "SELECT id, body FROM issue WHERE title = 'Land queue'",
      )
      .get()!;
    app.db
      .query("UPDATE issue SET body = ?1 WHERE id = ?2")
      .run(`Closes #${sandbox.number}`, queueIssue.id);
    try {
      const view = pillarView(app.db, fresh(), new Date())!;
      const trustAsk = askToLiveFor(app, fresh(), view, alice).find(
        (a) => a.pillar === "P0 Trust",
      )!.askToLive;
      // sandbox once, live 12h after it was asked (the first of its two pulls to go live).
      expect(trustAsk).toEqual({
        medianHours: 12,
        slowest: { number: sandbox.number, hours: 12 },
      });
    } finally {
      app.db
        .query("UPDATE issue SET body = ?1 WHERE id = ?2")
        .run(queueIssue.body, queueIssue.id);
    }
  });

  test("a repository with no pillars shows none of it", async () => {
    const made = await createRepo(app, alice, {
      name: "plain",
      visibility: "private",
    });
    if (!made.ok) throw new Error(String(made.error));
    const record = insertApp(app.db, {
      repoId: made.value.id,
      slug: "plain",
      access: "private",
    });
    if (!record.ok) throw new Error(record.error);
    expect(openIssue(app, alice, made.value, { title: "P is for plain" }).ok).toBe(true);
    const data = await api("/api/v1/repos/alice/plain/map");
    expect("pillars" in data).toBe(false);
    expect("mergedByPillar" in data).toBe(false);
    expect("pillar" in data.issues[0]).toBe(false);
    expect(await get("/alice/plain/map")).not.toContain('id="map-pillars"');
    expect(await get("/board?apps=plain")).not.toContain(
      'data-pillars',
    );
  });

  describe("the plan's own issues are not work", () => {
    let bare: Repo;
    let pillar: Issue;
    let umbrella: Issue;
    let barrier: Issue;
    let work: Issue;
    let chore: Issue;
    const own = (title: string): Issue => {
      const opened = openIssue(app, alice, getRepoById(app.db, bare.id)!, {
        title,
      });
      if (!opened.ok) throw new Error(String(opened.error));
      return opened.value;
    };
    const now = () => getRepoById(app.db, bare.id)!;
    const state = (issue: Issue) => getIssueById(app.db, issue.id)!.state;

    beforeAll(async () => {
      const made = await createRepo(app, alice, {
        name: "bare",
        visibility: "private",
      });
      if (!made.ok) throw new Error(String(made.error));
      bare = made.value;
      const seeded = await commitToBranch(app, alice, bare, {
        message: "Start",
        files: [{ path: "README.md", content: "# bare\n" }],
      });
      if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
      expect(addToCrew(app, alice, bare, "mason").ok).toBe(true);
      // Nothing serves the pillar yet, nothing is deferred, and the gate
      // waits for nothing: each has nothing open in front of it.
      pillar = own("P0 Trust: agents contained");
      umbrella = own("Later: work that serves no pillar now");
      barrier = own("Later gate: nothing behind this starts");
      work = own("Real work");
      chore = own("A chore");
    });

    test("an umbrella, the Later umbrella and the gate are never ready: not for the crew, not on the map", async () => {
      const graph = repoGraph(app.db, bare.id);
      expect([...graph.structural].sort()).toEqual(
        [pillar.id, umbrella.id, barrier.id].sort(),
      );
      expect(readyNow(graph).map((r) => r.issue.number)).toEqual([
        work.number,
        chore.number,
      ]);
      const data = await api("/api/v1/repos/alice/bare/map");
      expect(data.ready.map((r: { number: number }) => r.number)).toEqual([
        work.number,
        chore.number,
      ]);
      // Each says whose it is, rather than reading ready or blocked.
      for (const own of [pillar, umbrella, barrier])
        expect(
          data.issues.find((i: { number: number }) => i.number === own.number),
        ).toMatchObject({
          word: "parked",
          parkedBecause:
            "the plan's own: a person closes it, the crew never picks it",
        });
      expect(data.counts).toMatchObject({ ready: 2, parked: 3 });
      const page = await get("/alice/bare/map?view=graph");
      const listed = page.slice(
        page.indexOf("<h2>Ready now</h2>"),
        page.indexOf("</section>", page.indexOf("<h2>Ready now</h2>")),
      );
      expect(listed).toContain("Real work");
      expect(listed).not.toContain("Later gate");
      expect(listed).not.toContain("P0 Trust");
      expect(listed).not.toContain("Later: work");
      // The planner's own answer lists the same ready work.
      const plan = await tool("map", { app: "alice/bare" });
      expect(
        plan.value.ready.map((r: { number: number }) => r.number),
      ).toEqual([work.number, chore.number]);
    });

    test("refused: an agent does not close one, whatever access it holds; a merged pull does not; a person who writes does", async () => {
      const close = (who: User, issue: Issue) => {
        const closed = setIssueState(
          app,
          who,
          now(),
          getIssueById(app.db, issue.id)!,
          "closed",
        );
        return closed.ok ? "closed" : closed.error;
      };
      for (const own of [barrier, umbrella, pillar])
        expect(close(mason, own)).toBe("forbidden");
      // An agent that was given the forge's highest access still does not:
      // it may close work, and not the plan's own.
      app.db.query("UPDATE user SET is_admin = 1 WHERE id = ?1").run(mason.id);
      const mighty = getUserByName(app.db, "mason")!;
      expect(mighty.isAdmin).toBe(true);
      for (const own of [barrier, umbrella, pillar])
        expect(close(mighty, own)).toBe("forbidden");
      expect(close(mighty, chore)).toBe("closed");
      app.db.query("UPDATE user SET is_admin = 0 WHERE id = ?1").run(mason.id);
      for (const own of [barrier, umbrella, pillar])
        expect(state(own)).toBe("open");

      // A change that says it closes the gate lands, and closes only work.
      const branch = await commitToBranch(app, alice, now(), {
        branch: "feature/real",
        base: "main",
        message: "Real work",
        files: [{ path: "real.md", content: "real\n" }],
      });
      if (!branch.ok) throw new Error(JSON.stringify(branch.error));
      const opened = await openPull(app, alice, now(), {
        title: "Real work",
        body: `Closes #${work.number}\nCloses #${barrier.number}\nCloses #${pillar.number}`,
        baseBranch: "main",
        headBranch: "feature/real",
      });
      if (!opened.ok) throw new Error(String(opened.error));
      const merged = await mergePull(app, alice, now(), opened.value, "squash");
      if (!merged.ok) throw new Error(JSON.stringify(merged.error));
      expect(state(work)).toBe("closed");
      expect(state(barrier)).toBe("open");
      expect(state(pillar)).toBe("open");

      // A person who writes the repository closes the gate, by hand.
      expect(close(alice, barrier)).toBe("closed");
      expect(state(barrier)).toBe("closed");
    });
  });
});
