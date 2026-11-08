/**
 * Milestones: how far each thing asked for is, read from the dependency
 * tree. The top-level limbs are the pillars and Later (or, with no pillars,
 * the plan's roots), each one line with its weight; a milestone opened says
 * who is building, what is blocked and on what, what merged this week and
 * when it lands at this week's pace; a limb that does not move, or is heavy
 * with nobody on it, is a candidate to trim. The page, the API and the MCP
 * tool give the same numbers, and only an owner sees spend and names.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { linkIssue } from "../src/actions/dependencies.ts";
import { openIssue } from "../src/actions/issues.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { getIssueById, type Issue } from "../src/core/issues.ts";
import { readPlan } from "../src/core/milestones.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("milestones", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let alice: User;
  let mason: User;
  let engine: Repo;
  let plain: Repo;
  const cookies: Record<string, string> = {};
  let token: string;
  let trust: Issue;
  let feed: Issue;
  let later: Issue;
  let gate: Issue;
  let ship: Issue;
  let shell: Issue;
  let network: Issue;
  let disk: Issue;
  let names: Issue;
  let home: Issue;
  let big: Issue;
  let stale: Issue;

  const fresh = (repo: Repo) => getRepoById(app.db, repo.id)!;
  const current = (issue: Issue) => getIssueById(app.db, issue.id)!;
  const issue = (repo: Repo, title: string): Issue => {
    const opened = openIssue(app, alice, fresh(repo), { title });
    if (!opened.ok) throw new Error(String(opened.error));
    return opened.value;
  };
  const link = (repo: Repo, waiter: Issue, on: Issue): void => {
    const linked = linkIssue(
      app,
      alice,
      fresh(repo),
      current(waiter),
      current(on),
    );
    if (!linked.ok) throw new Error(String(linked.error));
  };
  /** A pull that closes an issue, landed on main. */
  const land = async (name: string, closes: Issue): Promise<number> => {
    const branch = await commitToBranch(app, alice, fresh(engine), {
      branch: `feature/${name}`,
      base: "main",
      message: name,
      files: [{ path: `${name}.md`, content: `${name}\n` }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, fresh(engine), {
      title: `Land ${name}`,
      body: `Closes #${closes.number}`,
      baseBranch: "main",
      headBranch: `feature/${name}`,
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const merged = await mergePull(
      app,
      alice,
      fresh(engine),
      opened.value,
      "squash",
    );
    if (!merged.ok) throw new Error(JSON.stringify(merged.error));
    return opened.value.number;
  };
  const get = async (who: string, path: string) =>
    fetch(`${base}${path}`, { headers: { cookie: cookies[who]! } });
  const api = async (path: string) =>
    fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
  let nextId = 1;
  const tool = async (args: unknown) => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: nextId++,
        method: "tools/call",
        params: { name: "milestones", arguments: args },
      }),
    });
    const body = (await res.json()) as any;
    const text: string = body.result.content[0].text;
    return body.result.isError === true
      ? { error: text }
      : { value: JSON.parse(text) };
  };
  let landed: number;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-milestones-"));
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
      cookies[username] = (
        (
          await fetch(`${base}/signin`, {
            method: "POST",
            body: new URLSearchParams({
              username,
              password: "a-good-passphrase",
            }),
            redirect: "manual",
          })
        ).headers.get("set-cookie") ?? ""
      ).split(";")[0]!;
    }
    alice = getUserByName(app.db, "alice")!;
    token = createToken(app.db, alice.id, "ro", "ro").token;
    for (const name of ["engine", "plain"]) {
      // Public, so bob reads them and writes nothing.
      const made = await createRepo(app, alice, { name, visibility: "public" });
      if (!made.ok) throw new Error(String(made.error));
      const seeded = await commitToBranch(app, alice, made.value, {
        message: "Start",
        files: [{ path: "README.md", content: `# ${name}\n` }],
      });
      if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
      const record = insertApp(app.db, {
        repoId: made.value.id,
        slug: name,
        access: "private",
      });
      if (!record.ok) throw new Error(record.error);
      if (name === "engine") engine = made.value;
      else plain = made.value;
    }
    const agent = await createAgent(app, alice, { username: "mason" });
    if (!agent.ok) throw new Error(String(agent.error));
    expect(addToCrew(app, alice, engine, "mason").ok).toBe(true);
    mason = getUserByName(app.db, "mason")!;

    trust = issue(engine, "P0 Trust: agents contained");
    feed = issue(engine, "P1 Feed: one front door");
    later = issue(engine, "Later: work that serves no pillar now");
    gate = issue(engine, "Later gate: nothing behind this starts");
    link(engine, feed, trust);
    link(engine, gate, trust);
    // P0: a milestone of three, and a leaf.
    ship = issue(engine, "Ship the sandbox");
    shell = issue(engine, "Sandbox the shell");
    network = issue(engine, "Sandbox the network");
    disk = issue(engine, "Sandbox the disk");
    names = issue(engine, "Reserved names");
    for (const part of [shell, network, disk]) link(engine, ship, part);
    link(engine, disk, network);
    link(engine, trust, ship);
    link(engine, trust, names);
    // P1: a leaf, a heavy limb nobody is on, and a limb that does not move.
    home = issue(engine, "Home is the feed");
    big = issue(engine, "One interface, no dev mode");
    const pages = Array.from({ length: 9 }, (_, n) =>
      issue(engine, `Fold page ${n + 1}`),
    );
    for (const page of pages) link(engine, big, page);
    stale = issue(engine, "Reply and like");
    link(engine, stale, issue(engine, "A like is a signal"));
    // It has been here ten days.
    app.db
      .query("UPDATE issue SET created_at = ?1 WHERE id = ?2")
      .run(new Date(Date.now() - 10 * 86_400_000).toISOString(), stale.id);
    for (const under of [home, big, stale]) link(engine, feed, under);

    // The shell landed this week and cost something; mason is on the network.
    const spent = createRun(app.db, {
      repoId: engine.id,
      kind: "agent",
      issueId: shell.id,
      actorId: mason.id,
      reason: "assigned",
    });
    claimRun(app.db, spent.id);
    finishRun(app.db, spent.id, {
      state: "ok",
      summary: "opened pull",
      costUsd: 1.5,
    });
    landed = await land("shell", shell);
    await land("page-1", pages[0]!);
    const running = createRun(app.db, {
      repoId: engine.id,
      kind: "agent",
      issueId: network.id,
      actorId: mason.id,
      reason: "assigned",
    });
    claimRun(app.db, running.id);
  }, 60_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the top-level limbs are the pillars and Later, each with its weight", () => {
    const plan = readPlan(app.db, fresh(engine), { spend: true });
    expect(
      plan.limbs.map((l) => [l.name, l.issue.number, l.deferred]),
    ).toEqual([
      ["P0 Trust", trust.number, false],
      ["P1 Feed", feed.number, false],
      ["Later", later.number, true],
    ]);
    const [p0, p1, deferred] = plan.limbs;
    // The milestone itself, its three parts, and the leaf.
    expect(p0!.weight).toMatchObject({
      total: 5,
      done: 1,
      open: 4,
      building: 1,
      merged: 1,
      spentUsd: 1.5,
    });
    expect(p0!.weight.last).not.toBeNull();
    expect(p0!.trim).toBeUndefined();
    // The leaf, the heavy limb with its nine, the still limb with its one.
    expect(p1!.weight).toMatchObject({
      total: 13,
      done: 1,
      open: 12,
      building: 0,
      merged: 1,
    });
    expect(p1!.trim).toBe("12 open and nobody building");
    // Another pillar's umbrella is an order, not work beneath this one.
    expect(deferred!.weight).toMatchObject({ total: 0, open: 0 });
    expect(deferred!.trim).toBeUndefined();
  });

  test("a milestone opened: who is building, what is blocked and on what, what merged, and an estimate", () => {
    const plan = readPlan(app.db, fresh(engine), { spend: true });
    const m = plan.milestone(ship.number)!;
    expect(m.name).toBe("Ship the sandbox");
    expect(m.weight).toMatchObject({ total: 3, done: 1, open: 2, building: 1 });
    expect(m.building.map((b) => [b.issue.number, b.who])).toEqual([
      [network.number, "mason"],
    ]);
    expect(
      m.blocked.map((b) => [b.issue.number, b.on.map((o) => o.number)]),
    ).toEqual([[disk.number, [network.number]]]);
    expect(m.merged.map((p) => p.number)).toEqual([landed]);
    expect(m.estimate).toBe(
      "About 14 days at this week's pace: 1 closed in 7 days, 2 open.",
    );
    expect(m.limbs).toEqual([]);
    expect(m.leaves.map((l) => [l.issue.number, l.state])).toEqual([
      [network.number, "building"],
      [disk.number, "blocked"],
      [shell.number, "done"],
    ]);
    // An issue that waits for nothing is no milestone.
    expect(plan.milestone(names.number)).toBeUndefined();
    expect(plan.milestone(99_999)).toBeUndefined();
  });

  test("a limb's own limbs stay collapsed, and one that does not move or is heavy with nobody on it is flagged", () => {
    const plan = readPlan(app.db, fresh(engine), { spend: false });
    const p0 = plan.milestone(trust.number)!;
    expect(p0.limbs.map((l) => [l.name, l.weight.done, l.weight.total])).toEqual(
      [["Ship the sandbox", 1, 3]],
    );
    expect(p0.leaves.map((l) => [l.issue.number, l.state])).toEqual([
      [names.number, "ready"],
    ]);
    // A viewer who may not see owner facts gets no spend at all.
    expect("spentUsd" in p0.weight).toBe(false);
    const p1 = plan.milestone(feed.number)!;
    expect(p1.limbs.map((l) => [l.issue.number, l.trim])).toEqual([
      [big.number, "8 open and nobody building"],
      [stale.number, "nothing landed in 7 days"],
    ]);
    expect(p1.leaves.map((l) => l.issue.number)).toEqual([home.number]);
    expect(plan.milestone(stale.number)!.estimate).toBe(
      "Nothing closed here in 7 days, so there is no pace to estimate from.",
    );
    // What waits only for the plan's furniture has nothing beneath it.
    expect(plan.milestone(gate.number)!.estimate).toBe(
      "Nothing beneath it counts as work yet.",
    );
  });

  test("with no pillars, the limbs are the plan's roots", () => {
    const release = issue(plain, "Release 1.0");
    const parser = issue(plain, "Parser");
    const lexer = issue(plain, "Lexer");
    const docs = issue(plain, "Docs");
    link(plain, release, parser);
    link(plain, parser, lexer);
    link(plain, docs, issue(plain, "A tutorial"));
    issue(plain, "A loose end");
    const plan = readPlan(app.db, fresh(plain));
    expect(plan.limbs.map((l) => [l.name, l.weight.total])).toEqual([
      ["Release 1.0", 2],
      ["Docs", 1],
    ]);
    expect(
      plan.milestone(release.number)!.limbs.map((l) => l.issue.number),
    ).toEqual([parser.number]);
  });

  test("the pages: the limbs on one, a milestone on the other; an owner sees spend and names, a reader neither", async () => {
    const limbs = await (await get("alice", "/alice/engine/milestones")).text();
    expect(limbs).toContain('id="ms-limbs"');
    expect(limbs).toContain(
      `<a href="/alice/engine/milestones/${trust.number}"`,
    );
    expect(limbs).toMatch(/<progress[^>]*aria-label="[^"]*: 1 of 5 done"/);
    expect(limbs).toMatch(/class="pill"[^>]*>\s*1 of 5 done/);
    expect(limbs).toContain("list setting-list");
    expect(limbs).toMatch(/class="badge"[^>]*>\s*trim/);
    expect(limbs).toContain("4 open");
    expect(limbs).toContain("1 building");
    expect(limbs).toContain("$1.50");
    expect(limbs).toContain("A candidate to trim: 12 open and nobody building.");
    // Leaves appear only on the limb they are under.
    expect(limbs).not.toContain("Sandbox the network");

    const one = await (
      await get("alice", `/alice/engine/milestones/${ship.number}`)
    ).text();
    expect(one).toContain("<h1>Ship the sandbox</h1>");
    expect(one).toMatch(/<b>1<\/b> of 3 done/);
    expect(one).toContain('aria-label="1 of 3 done"');
    expect(one).toMatch(/class="badge"[^>]*>\s*done/);
    expect(one).toContain(
      "About 14 days at this week&#39;s pace: 1 closed in 7 days, 2 open.",
    );
    expect(one).toContain('id="ms-building"');
    expect(one).toMatch(/mason · since/);
    expect(one).toContain('id="ms-blocked"');
    expect(one).toContain(`href="/alice/engine/issues/${network.number}"`);
    expect(one).toContain(`href="/alice/engine/pulls/${landed}"`);
    expect(one).toContain("$1.50");
    // What it cost and landed, with its costliest: the shell, $1.50, one change.
    const spend = one.slice(
      one.indexOf('id="ms-spend"'),
      one.indexOf("</section>", one.indexOf('id="ms-spend"')),
    );
    expect(spend).toMatch(/<b>\$1\.50<\/b> spent/);
    expect(spend).toMatch(/<b>1<\/b> change\s+landed/);
    expect(spend).toContain("Sandbox the shell");
    // Each issue once: the network is under Building now and the disk under
    // Blocked, so Issues lists neither again, only what closed.
    const issues = one.slice(
      one.indexOf('id="ms-leaves"'),
      one.indexOf("</section>", one.indexOf('id="ms-leaves"')),
    );
    expect(issues).toContain("1 closed");
    expect(issues).toContain("Sandbox the shell");
    expect(issues).not.toContain("Sandbox the network");
    expect(issues).not.toContain("Sandbox the disk");
    expect(issues).not.toContain("None open.");

    const theirs = await (
      await get("bob", `/alice/engine/milestones/${ship.number}`)
    ).text();
    expect(theirs).toMatch(/<b>1<\/b> of 3 done/);
    expect(theirs).not.toContain("$1.50");
    expect(theirs).not.toContain('id="ms-spend"');
    expect(theirs).not.toContain("mason");
    expect(theirs).toMatch(/the crew · since/);

    // An issue that waits for nothing has no milestone page.
    expect(
      (await get("alice", `/alice/engine/milestones/${names.number}`)).status,
    ).toBe(404);
    expect((await get("alice", "/alice/engine/milestones/abc")).status).toBe(404);
  });

  test("one tap from the map, the board and the issue itself", async () => {
    const map = await (await get("alice", "/alice/engine/map")).text();
    expect(map).toContain('href="/alice/engine/milestones"');
    expect(map).toContain(`href="/alice/engine/milestones/${trust.number}"`);
    const board = await (await get("alice", "/board")).text();
    expect(board).toContain(`href="/alice/engine/milestones/${feed.number}"`);
    // The issue page, in the studio's face and in dev's.
    for (const mode of ["", "?mode=dev"]) {
      const page = await (
        await get("alice", `/alice/engine/issues/${ship.number}${mode}`)
      ).text();
      expect(page).toContain(`/alice/engine/milestones/${ship.number}`);
      const leaf = await (
        await get("alice", `/alice/engine/issues/${names.number}${mode}`)
      ).text();
      expect(leaf).not.toContain(`/alice/engine/milestones/${names.number}`);
    }
  });

  test("the API and the MCP's `milestones` return the same numbers", async () => {
    const limbs = (await (
      await api("/api/v1/repos/alice/engine/milestones")
    ).json()) as { items: Record<string, unknown>[]; next_cursor: string | null };
    expect(limbs.next_cursor).toBeNull();
    expect(limbs.items.map((l) => l["name"])).toEqual([
      "P0 Trust",
      "P1 Feed",
      "Later",
    ]);
    expect(limbs.items[0]).toMatchObject({
      number: trust.number,
      done: 1,
      total: 5,
      open: 4,
      building: 1,
      mergedInDays: { days: 7, merged: 1 },
      spentUsd: 1.5,
      deferred: false,
    });
    expect(limbs.items[1]).toMatchObject({
      trim: "12 open and nobody building",
    });
    expect(((await tool({ app: "alice/engine" })).value as any).limbs).toEqual(limbs.items);

    const first = (await (
      await api("/api/v1/repos/alice/engine/milestones?limit=2")
    ).json()) as { items: unknown[]; next_cursor: string | null };
    expect(first.items).toEqual(limbs.items.slice(0, 2));
    expect(first.next_cursor).toBe("2");
    const last = (await (
      await api(`/api/v1/repos/alice/engine/milestones?limit=2&cursor=${first.next_cursor}`)
    ).json()) as { items: unknown[]; next_cursor: string | null };
    expect(last.items).toEqual(limbs.items.slice(2));
    expect(last.next_cursor).toBeNull();
    for (const bad of ["limit=0", "limit=201", "limit=x", "cursor=abc"]) {
      const res = await api(`/api/v1/repos/alice/engine/milestones?${bad}`);
      expect(res.status).toBe(422);
    }

    const one = (await (
      await api(`/api/v1/repos/alice/engine/milestones/${ship.number}`)
    ).json()) as Record<string, unknown>;
    expect(one).toMatchObject({
      number: ship.number,
      name: "Ship the sandbox",
      done: 1,
      total: 3,
      estimate:
        "About 14 days at this week's pace: 1 closed in 7 days, 2 open.",
      // The count, as on a limb, and under its own name who is on what.
      building: 1,
      buildingNow: [{ number: network.number, who: "mason" }],
      blocked: [{ number: disk.number, on: [{ number: network.number }] }],
      merged: [{ number: landed }],
      limbs: [],
    });
    expect(
      (await tool({ app: "alice/engine", issue: ship.number })).value,
    ).toEqual(one);

    expect(
      (await api(`/api/v1/repos/alice/engine/milestones/${names.number}`))
        .status,
    ).toBe(404);
    expect(
      (await tool({ app: "alice/engine", issue: names.number })).error,
    ).toBe("not_a_milestone: no issue by that number waits for others here");
    // A reader's token gets the numbers without spend or names.
    const reader = createToken(
      app.db,
      getUserByName(app.db, "bob")!.id,
      "ro",
      "ro",
    ).token;
    const theirs = (await (
      await fetch(`${base}/api/v1/repos/alice/engine/milestones/${ship.number}`, {
        headers: { authorization: `Bearer ${reader}` },
      })
    ).json()) as Record<string, any>;
    expect("spentUsd" in theirs).toBe(false);
    expect("spend" in theirs).toBe(false);
    expect(one["spend"]).toMatchObject({
      usd: 1.5,
      landed: 1,
      costliest: [{ number: shell.number, usd: 1.5 }],
    });
    expect(theirs["buildingNow"][0].who).toBe("the crew");
    expect(theirs["done"]).toBe(1);
  });

  test("Later counts what waits behind the gate, whether or not the Later umbrella waits for it: the milestone agrees with the map", async () => {
    // One filed behind the gate alone, one behind it and under Later.
    const slider = issue(engine, "A profit slider");
    link(engine, slider, gate);
    const adapters = issue(engine, "Adapters");
    link(engine, adapters, gate);
    link(engine, later, adapters);
    const plan = readPlan(app.db, fresh(engine), { spend: false });
    const limb = plan.limbs.find((l) => l.name === "Later")!;
    expect(limb.weight).toMatchObject({ total: 2, done: 0, open: 2 });
    const opened = plan.milestone(later.number)!;
    expect(opened.leaves.map((l) => [l.issue.number, l.state])).toEqual([
      [slider.number, "deferred"],
      [adapters.number, "deferred"],
    ]);
    const map = (await (
      await api("/api/v1/repos/alice/engine/map")
    ).json()) as { pillars: { pillar: string | null; open: number }[] };
    expect(map.pillars.find((row) => row.pillar === "Later")!.open).toBe(
      limb.weight.open,
    );
    const page = await (
      await get("alice", `/alice/engine/milestones/${later.number}`)
    ).text();
    expect(page).toMatch(/<b>0<\/b> of 2 done/);
    expect(page).toContain("A profit slider");
  });

  test("a milestone's spend adds up: its dollars are its issues' dollars, the three dearest are named, and a reader sees none", () => {
    const top = issue(plain, "Cost 1.0");
    const parts = [0.5, 3, 1, 2.25].map((usd, n) => {
      const part = issue(plain, `Costed ${n + 1}`);
      link(plain, top, part);
      const run = createRun(app.db, {
        repoId: plain.id,
        kind: "agent",
        issueId: part.id,
        actorId: mason.id,
        reason: "assigned",
      });
      claimRun(app.db, run.id);
      finishRun(app.db, run.id, { state: "ok", summary: "x", costUsd: usd });
      return part;
    });
    const free = issue(plain, "Costed nothing");
    link(plain, top, free);
    const m = readPlan(app.db, fresh(plain), { spend: true }).milestone(
      top.number,
    )!;
    expect(m.spend!.usd).toBe(6.75);
    expect(m.spend!.usd).toBe(m.weight.spentUsd!);
    expect(m.spend!.landed).toBe(0);
    expect(m.spend!.costliest.map((c) => [c.issue.number, c.usd])).toEqual([
      [parts[1]!.number, 3],
      [parts[3]!.number, 2.25],
      [parts[2]!.number, 1],
    ]);
    // The three named are never more than the whole.
    expect(m.spend!.costliest.reduce((sum, c) => sum + c.usd, 0)).toBeLessThanOrEqual(
      m.spend!.usd,
    );
    const reader = readPlan(app.db, fresh(plain), { spend: false }).milestone(
      top.number,
    )!;
    expect(reader.spend).toBeUndefined();
  });
});
