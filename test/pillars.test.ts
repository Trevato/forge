/**
 * Pillars: every issue carries the one it serves. An umbrella a writer
 * opened names a pillar and a stranger's names nothing; an issue linked
 * under an umbrella gets the pillar's label, made on first use, by a link,
 * by a plan that names the pillar, by a split, and at boot for what was
 * linked before; the map counts open work by pillar and reads "no pillar"
 * for the rest; the board and the map's data count the week's merged pulls
 * by pillar.
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
import { addDependency, dependenciesOf } from "../src/core/dependencies.ts";
import {
  getIssueById,
  getLabel,
  labelsFor,
  listIssues,
  listLabels,
  setIssueLabels,
  type Issue,
} from "../src/core/issues.ts";
import {
  mergedByPillar,
  pillarsOf,
  pillarWindowStart,
} from "../src/core/pillars.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
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
  let loose: Issue;
  let composer: Issue;
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
    repo = made.value;
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

    trust = issue("P0 Trust: agents contained, every agent pull reviewed");
    feed = issue("P1 Feed: one front door");
    later = issue("Later: work that serves no pillar now");
    gate = issue("Later gate: nothing behind this starts until it is opened");
    // A stranger's issues, titled like umbrellas.
    spam = issue("P9 Spam: hello", bob);
    issue("P0 Trust: mine now", bob);
    // An order between pillars, and the gate behind them: not membership.
    expect(link(feed, trust).ok).toBe(true);
    expect(link(gate, trust).ok).toBe(true);
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an umbrella a writer opened names a pillar, in order; a stranger's names nothing", () => {
    expect(
      pillarsOf(app.db, fresh()).map((p) => [p.name, p.number]),
    ).toEqual([
      ["P0 Trust", trust.number],
      ["P1 Feed", feed.number],
      ["Later", later.number],
    ]);
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

  test("the `plan` tool takes a pillar per item: filed under its umbrella, labelled; an unknown pillar refuses the plan", async () => {
    const before = listIssues(app.db, repo.id, { state: "open", limit: 100 }).length;
    const unknown = await tool("plan", {
      app: "alice/engine",
      issues: [
        { key: "a", title: "A thing", pillar: "P7 Steering" },
        { key: "b", title: "Another" },
      ],
    });
    expect(unknown.error).toBe(
      'unknown_pillar: "a": no pillar "P7 Steering" here; the pillars are P0 Trust, P1 Feed, Later',
    );
    expect(
      listIssues(app.db, repo.id, { state: "open", limit: 100 }).length,
    ).toBe(before);
    const planned = await tool("plan", {
      app: "alice/engine",
      issues: [
        { key: "composer", title: "A composer above the timeline", pillar: "p1 feed" },
        { key: "footer", title: "Tidy the footer", blockedBy: ["composer"] },
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
    footer = byNumber(opened.get("footer")!);
    expect(names(composer)).toEqual(["P1 Feed"]);
    expect(
      dependenciesOf(app.db, feed.id).blockedBy.map((i) => i.number),
    ).toContain(composer.number);
    expect(names(footer)).toEqual([]);
  });

  test("an issue split into parts: each part that names no pillar carries its parent's", () => {
    parts = [issue("Review: the queue"), issue("Review: the verdict")];
    const split = setIssueState(app, alice, fresh(), current(review), "closed", {
      reason: "split",
      into: parts.map((p) => p.number),
    });
    expect(split.ok).toBe(true);
    for (const part of parts) expect(names(part)).toEqual(["P0 Trust"]);
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
    expect(events("issue.labeled")).toBe(said);
  });

  test("the map counts open work by pillar, links each pillar to its issues, and reads no pillar for the rest", async () => {
    // One of P0's three open issues waits for another.
    expect(link(sandbox, parts[0]!).ok).toBe(true);
    const data = await api("/api/v1/repos/alice/engine/map");
    expect(data.pillars).toEqual([
      { pillar: "P0 Trust", umbrella: trust.number, open: 3, ready: 2, blocked: 1 },
      { pillar: "P1 Feed", umbrella: feed.number, open: 2, ready: 2, blocked: 0 },
      { pillar: "Later", umbrella: later.number, open: 1, ready: 1, blocked: 0 },
      // The loose issue and the plan's footer (which waits for the composer),
      // and the stranger's two (one of which waits for the loose issue).
      { pillar: null, open: 4, ready: 2, blocked: 2 },
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
    expect(pillarOf.get(loose.number)).toBeNull();
    expect(pillarOf.get(spam.number)).toBeNull();
    // An umbrella reads as its own pillar, never as no pillar.
    expect(pillarOf.get(trust.number)).toBe("P0 Trust");
    // The MCP's `map` is the same data.
    const mcp = await tool("map", { app: "alice/engine" });
    expect(mcp.value.pillars).toEqual(data.pillars);
    expect(mcp.value.mergedByPillar).toEqual(data.mergedByPillar);

    const page = await get("/alice/engine/map");
    expect(page).toContain('id="map-pillars"');
    expect(page).toContain(
      '<a href="/alice/engine/issues?label=P0%20Trust">P0 Trust</a>',
    );
    expect(page).toContain("3 open · 2 ready · 1 blocked");
    expect(page).toContain("<b>no pillar</b>");
    expect(page).toContain(`href="/alice/engine/issues/${loose.number}"`);
    // The pillar's link is the list narrowed to its label.
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
    // Merged, but ten days ago: outside the week.
    const old = await land("verdict", parts[1]!);
    app.db
      .query("UPDATE pull SET merged_at = ?1 WHERE issue_id = ?2")
      .run(new Date(Date.now() - 10 * 86_400_000).toISOString(), old);
    const want = [
      { pillar: "P0 Trust", merged: 2 },
      { pillar: "P1 Feed", merged: 1 },
      { pillar: "Later", merged: 0 },
      { pillar: null, merged: 2 },
    ];
    expect(
      mergedByPillar(
        app.db,
        fresh(),
        pillarsOf(app.db, fresh()),
        pillarWindowStart(),
      ),
    ).toEqual(want);
    const data = await api("/api/v1/repos/alice/engine/map");
    expect(data.mergedByPillar).toEqual({ days: 7, counts: want });

    const board = await get("/board");
    expect(board).toMatch(/merged in\s+7 days/);
    expect(board).toContain("P0 Trust <b>2</b>");
    expect(board).toContain("P1 Feed <b>1</b>");
    expect(board).toContain("Later <b>0</b>");
    expect(board).toContain("no pillar <b>2</b>");
    expect(board).toContain('href="/alice/engine/issues?label=P1%20Feed"');
    expect(board).toMatch(/data-zero="yes"\s+href="\/alice\/engine\/issues\?label=Later"/);
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
      'class="board-pillars"',
    );
  });
});
