/**
 * Acting on a whole limb: defer it, resume it, or close it as not doing,
 * each one fleet operation with its plan, receipt and undo.
 *
 * The refusals come first: a reader, an agent (the planner too), a
 * stranger and a read token change nothing, by any door. Then the rule a
 * deferral rests on — what only deferred work waits for is deferred too,
 * and is never ready — and each action: the preview is what the apply then
 * writes, what something outside the limb still needs is never taken, and
 * undo puts it back.
 */
import { seatAs } from "./helpers/seat.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { linkIssue, unlinkIssue } from "../src/actions/dependencies.ts";
import { undoFleetOp } from "../src/actions/fleet.ts";
import { openIssue, setIssueState } from "../src/actions/issues.ts";
import { applyLimb, previewLimb } from "../src/actions/limbs.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import {} from "../src/core/agents.ts";
import {
  dependenciesOf,
  readyNow,
  repoGraph,
} from "../src/core/dependencies.ts";
import {
  getIssueById,
  labelsFor,
  listComments,
  type Issue,
} from "../src/core/issues.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("limb actions", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let alice: User;
  let bob: User;
  let mason: User;
  let atlas: User;
  let engine: Repo;
  let secret: Repo;
  let plain: Repo;
  let trust: Issue;
  let feed: Issue;
  let later: Issue;
  let gate: Issue;
  /** The limb under P1, its three leaves, and what P0's ship also needs. */
  let iface: Issue;
  let home: Issue;
  let lists: Issue;
  let search: Issue;
  let shared: Issue;
  let ship: Issue;
  let loose: Issue;
  let hidden: Issue;

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
  const waitsFor = (on: Issue): number[] =>
    dependenciesOf(app.db, on.id).blockedBy.map((i) => i.number);
  const waitedBy = (on: Issue): number[] =>
    dependenciesOf(app.db, on.id).blocks.map((i) => i.number);
  const deferred = (): number[] => {
    const graph = repoGraph(app.db, engine.id);
    return graph.issues
      .filter((i) => graph.deferred.has(i.id))
      .map((i) => i.number)
      .sort((a, b) => a - b);
  };
  const ready = (): number[] =>
    readyNow(repoGraph(app.db, engine.id))
      .map((r) => r.issue.number)
      .sort((a, b) => a - b);
  /** The engine's edges and states, to say "nothing changed" exactly. */
  const snapshot = (): string =>
    JSON.stringify(
      app.db
        .query(
          `SELECT 'e' AS k, issue_id AS a, blocked_by_id AS b FROM issue_dependency
           UNION ALL SELECT 's', id, state FROM issue ORDER BY 1, 2, 3`,
        )
        .all(),
    );
  const tokenOf = (user: User, scope: "ro" | "rw" | "admin"): string =>
    createToken(app.db, user.id, scope, scope).token;
  const post = (token: string, path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const cookies: Record<string, string> = {};
  const get = (who: string, path: string) =>
    fetch(`${base}${path}`, {
      headers: who === "" ? {} : { cookie: cookies[who]! },
      redirect: "manual",
    });
  const submit = (who: string, path: string, form: Record<string, string>) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        ...(who === "" ? {} : { cookie: cookies[who]! }),
        origin: base,
      },
      body: new URLSearchParams(form),
      redirect: "manual",
    });
  let nextId = 1;
  const tool = async (token: string, args: unknown) => {
    const res = await post(token, "/mcp", {
      jsonrpc: "2.0",
      id: nextId++,
      method: "tools/call",
      params: { name: "limb", arguments: args },
    });
    const body = (await res.json()) as any;
    const text: string = body.result.content[0].text;
    return body.result.isError === true
      ? { error: text }
      : { value: JSON.parse(text) };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-limbs-"));
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
    for (const name of ["alice", "bob"])
      cookies[name] = (
        (
          await fetch(`${base}/signin`, {
            method: "POST",
            body: new URLSearchParams({
              username: name,
              password: "a-good-passphrase",
            }),
            redirect: "manual",
          })
        ).headers.get("set-cookie") ?? ""
      ).split(";")[0]!;
    const repoOf = async (name: string, visibility: "public" | "private") => {
      const made = await createRepo(app, alice, { name, visibility });
      if (!made.ok) throw new Error(String(made.error));
      const seeded = await commitToBranch(app, alice, made.value, {
        message: "Start",
        files: [{ path: "README.md", content: `# ${name}\n` }],
      });
      if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
      return made.value;
    };
    // Public: bob reads the engine and writes nothing.
    engine = await repoOf("engine", "public");
    secret = await repoOf("secret", "private");
    plain = await repoOf("plain", "public");
    for (const name of ["mason", "atlas"]) {
      const agent = await createAgent(app, alice, { username: name });
      if (!agent.ok) throw new Error(String(agent.error));
      expect(addToCrew(app, alice, engine, name).ok).toBe(true);
    }
    mason = getUserByName(app.db, "mason")!;
    atlas = getUserByName(app.db, "atlas")!;
    seatAs(app.db, engine.id, atlas.id, "planner");

    trust = issue(engine, "P0 Trust: agents contained");
    feed = issue(engine, "P1 Feed: one front door");
    later = issue(engine, "Later: work that serves no pillar now");
    gate = issue(engine, "Later gate: nothing behind this starts");
    link(engine, feed, trust);
    // As on a real forge: the gate waits for every pillar.
    link(engine, gate, trust);
    link(engine, gate, feed);
    iface = issue(engine, "One interface");
    home = issue(engine, "One home");
    lists = issue(engine, "One list");
    search = issue(engine, "One search");
    shared = issue(engine, "A shared toolbar");
    ship = issue(engine, "Ship the sandbox");
    loose = issue(engine, "A loose end");
    for (const part of [home, lists, search, shared]) link(engine, iface, part);
    link(engine, search, lists);
    link(engine, feed, iface);
    // As the planner files them (#612): the leaves are under the pillar's
    // umbrella directly too — all but `search`, so both shapes are here.
    link(engine, feed, home);
    link(engine, feed, lists);
    link(engine, ship, shared);
    link(engine, trust, ship);
    hidden = issue(secret, "A hidden limb");
    link(secret, hidden, issue(secret, "A hidden leaf"));
  }, 60_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("refused: a reader, an agent, the planner, a stranger and a read token change nothing, by any door", async () => {
    const before = snapshot();
    for (const request of [
      { action: "defer" as const },
      { action: "close" as const, reason: "Not now." },
      { action: "resume" as const, pillar: "P0" },
    ]) {
      // A reader may look: every row comes back refused, and says why.
      const looked = previewLimb(app, bob, fresh(engine), iface.number, request);
      expect(looked.ok && looked.value.rows.length > 0).toBe(true);
      if (looked.ok)
        for (const row of looked.value.rows) {
          expect(row.outcome).toBe("refused");
          expect(row.reason).toBe("you are not an admin of alice/engine");
        }
      // …and applying writes none of them.
      const tried = await applyLimb(app, bob, fresh(engine), iface.number, request);
      expect(tried.ok && tried.value.rows.every((r) => r.outcome === "refused")).toBe(
        true,
      );
      // An agent never applies: not a builder, and not the planner.
      for (const agent of [mason, atlas]) {
        const refused = await applyLimb(
          app,
          agent,
          fresh(engine),
          iface.number,
          request,
        );
        expect(refused.ok ? "applied" : refused.error.code).toBe("forbidden");
      }
      // Nobody signed in, and a repository that cannot be seen.
      const nobody = await applyLimb(app, undefined, fresh(engine), iface.number, request);
      expect(nobody.ok ? "applied" : nobody.error.code).toBe("unauthorized");
      const unseen = await applyLimb(app, bob, fresh(secret), hidden.number, request);
      expect(unseen.ok ? "applied" : unseen.error.code).toBe("not_found");
      expect(
        previewLimb(app, bob, fresh(secret), hidden.number, request).ok,
      ).toBe(false);
    }
    // Over the API: a read token and a write token cannot apply; an agent's
    // token cannot either; a reader's admin token writes nothing.
    const path = `/api/v1/repos/alice/engine/milestones/${iface.number}/limb`;
    const apply = { action: "defer", dryRun: false };
    expect((await post(tokenOf(alice, "ro"), path, apply)).status).toBe(403);
    expect((await post(tokenOf(alice, "rw"), path, apply)).status).toBe(403);
    expect((await post(tokenOf(atlas, "rw"), path, apply)).status).toBe(403);
    // …whatever its token says: an agent is not a person.
    expect((await post(tokenOf(atlas, "admin"), path, apply)).status).toBe(403);
    expect(
      (await tool(tokenOf(atlas, "admin"), {
        app: "alice/engine",
        issue: iface.number,
        action: "defer",
        dryRun: false,
      })).error,
    ).toContain("forbidden");
    const theirs = await post(tokenOf(bob, "admin"), path, apply);
    expect(theirs.status).toBe(201);
    const theirRows = ((await theirs.json()) as { rows: { outcome: string }[] })
      .rows;
    expect(theirRows.length).toBe(4);
    expect(theirRows.every((r) => r.outcome === "refused")).toBe(true);
    expect(
      (
        await post(
          tokenOf(bob, "admin"),
          `/api/v1/repos/alice/secret/milestones/${hidden.number}/limb`,
          apply,
        )
      ).status,
    ).toBe(404);
    // Over MCP: applying takes an admin token, whoever asks.
    const args = { app: "alice/engine", issue: iface.number, action: "defer" };
    for (const token of [tokenOf(alice, "ro"), tokenOf(alice, "rw"), tokenOf(atlas, "rw")])
      expect((await tool(token, { ...args, dryRun: false })).error).toContain(
        "forbidden",
      );
    expect(
      (
        await tool(tokenOf(alice, "rw"), {
          app: "alice/engine",
          action: "undo",
          operation: "nope",
          dryRun: false,
        })
      ).error,
    ).toContain("forbidden");
    // A close needs its reason; an unknown action is no action.
    const bare = await applyLimb(app, alice, fresh(engine), iface.number, {
      action: "close",
    });
    expect(bare.ok ? "applied" : bare.error.code).toBe("bad_action");
    expect(
      (await post(tokenOf(alice, "admin"), path, { action: "burn", dryRun: false }))
        .status,
    ).toBe(422);
    expect(snapshot()).toBe(before);
  });

  test("what only deferred work waits for is deferred, and is never ready", () => {
    // Nothing is deferred yet but the Later umbrella itself.
    expect(deferred()).toEqual([later.number]);
    expect(ready()).toEqual(
      [home, lists, shared, loose].map((i) => i.number).sort((a, b) => a - b),
    );
  });

  test("defer: one previewed row for each issue of the limb, the limb first; what other work needs stays; undo brings it back", async () => {
    const plan = previewLimb(app, alice, fresh(engine), iface.number, {
      action: "defer",
    });
    if (!plan.ok) throw new Error(plan.error.message);
    const filed = [`behind #${gate.number}`, `under #${later.number}`];
    // The limb, then its leaves — the ones under the pillar's umbrella too,
    // which is why moving the limb alone would not have stopped the crew.
    expect(plan.value.rows).toMatchObject([
      { label: `alice/engine#${iface.number}`, before: [`under #${feed.number}`], after: filed, outcome: "change" },
      { label: `alice/engine#${home.number}`, before: [`under #${feed.number}`], after: filed, outcome: "change" },
      // `One search` waits for `One list`: before it, top down.
      { label: `alice/engine#${search.number}`, before: [], after: filed, outcome: "change" },
      { label: `alice/engine#${lists.number}`, before: [`under #${feed.number}`], after: filed, outcome: "change" },
    ]);
    // Everything it takes along, and what stays because P0's ship needs it.
    expect(plan.value.taken.map((i) => i.number)).toEqual(
      [iface, home, lists, search].map((i) => i.number),
    );
    expect(plan.value.kept.map((i) => i.number)).toEqual([shared.number]);
    // A plan is not a write.
    expect(waitedBy(iface)).toEqual([feed.number]);

    const op = await applyLimb(app, alice, fresh(engine), iface.number, {
      action: "defer",
    });
    if (!op.ok) throw new Error(op.error.message);
    expect(op.value.rows.map((r) => r.outcome)).toEqual(["ok", "ok", "ok", "ok"]);
    expect(op.value.rows.map((r) => [r.before, r.after])).toEqual(
      plan.value.rows.map((r) => [r.before, r.after]),
    );
    for (const moved of [iface, home, lists, search]) {
      expect(waitsFor(moved)).toContain(gate.number);
      expect(waitedBy(moved)).not.toContain(feed.number);
      expect(labelsFor(app.db, moved.id).map((l) => l.name)).toEqual(["Later"]);
    }
    expect(waitedBy(iface)).toEqual([later.number]);
    expect(deferred()).toEqual(
      [later, iface, home, lists, search]
        .map((i) => i.number)
        .sort((a, b) => a - b),
    );
    // The crew can pick none of it; what P0 also needs is still ready.
    expect(ready()).toEqual([shared.number, loose.number]);

    // Every surface says so, and why, in the same words. Each issue of the
    // limb waits behind the gate itself; something linked beneath one of
    // them afterwards is deferred through it, and says through which.
    const extra = issue(engine, "One home: the footer");
    link(engine, home, extra);
    const through = `only deferred work needs it: #${home.number} One home`;
    const ro = tokenOf(alice, "ro");
    const map = (await (
      await fetch(`${base}/api/v1/repos/alice/engine/map`, {
        headers: { authorization: `Bearer ${ro}` },
      })
    ).json()) as {
      issues: { number: number; word: string; deferredBecause?: string }[];
      counts: Record<string, number>;
      ready: { number: number }[];
    };
    const drawn = (issue: Issue) =>
      map.issues.find((i) => i.number === issue.number)!;
    for (const moved of [iface, home, lists, search])
      expect(drawn(moved)).toMatchObject({
        word: "deferred",
        deferredBecause: "behind the Later gate",
      });
    expect(drawn(extra)).toMatchObject({
      word: "deferred",
      deferredBecause: through,
    });
    // What something active also waits for, and what nothing waits for at
    // all, read as they did.
    expect(drawn(shared)).toMatchObject({ word: "ready" });
    expect(drawn(loose)).toMatchObject({ word: "ready" });
    expect("deferredBecause" in drawn(shared)).toBe(false);
    expect(map.counts["deferred"]).toBe(5);
    expect(map.ready.map((r) => r.number).sort((a, b) => a - b)).toEqual([
      shared.number,
      loose.number,
    ]);
    const asTool = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ro}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 900,
        method: "tools/call",
        params: { name: "map", arguments: { app: "alice/engine" } },
      }),
    });
    const told = JSON.parse(
      ((await asTool.json()) as any).result.content[0].text,
    ) as typeof map;
    expect(told.issues.find((i) => i.number === extra.number)).toMatchObject({
      word: "deferred",
      deferredBecause: through,
    });
    const mapPage = await (await get("alice", "/alice/engine/map")).text();
    expect(mapPage).toContain(
      `aria-label="#${extra.number} One home: the footer — deferred: ${through}"`,
    );
    expect(mapPage).toMatch(
      /class="badge"[^>]*data-state="deferred"[^>]*>deferred <b>5<\/b><\/span>/,
    );
    const issuePage = await (
      await get("alice", `/alice/engine/issues/${extra.number}`)
    ).text();
    expect(issuePage).toContain(`deferred: ${through}`);
    expect(issuePage).not.toContain("not picked up yet");
    expect(
      await (
        await get("alice", `/alice/engine/issues/${iface.number}`)
      ).text(),
    ).toContain("deferred: behind the Later gate");
    // The milestone and its data say it too.
    const limbData = (await (
      await fetch(
        `${base}/api/v1/repos/alice/engine/milestones/${iface.number}`,
        { headers: { authorization: `Bearer ${ro}` } },
      )
    ).json()) as {
      deferred: boolean;
      deferredBecause: string;
      limbs: { number: number; deferred: boolean; deferredBecause?: string }[];
      leaves: { number: number; state: string; deferredBecause?: string }[];
    };
    expect(limbData).toMatchObject({
      deferred: true,
      deferredBecause: "behind the Later gate",
    });
    // `One home` brings a tree of its own now (the footer): a limb, deferred.
    expect(limbData.limbs.find((l) => l.number === home.number)).toMatchObject(
      { deferred: true, deferredBecause: "behind the Later gate" },
    );
    expect(limbData.leaves.find((l) => l.number === lists.number)).toMatchObject(
      { state: "deferred", deferredBecause: "behind the Later gate" },
    );
    // What was linked beneath afterwards is not the limb's deferral to undo:
    // it goes before the undo, so the fixture is as it was.
    expect(unlinkIssue(app, alice, fresh(engine), current(home), current(extra)).ok).toBe(true);
    expect(setIssueState(app, alice, fresh(engine), current(extra), "closed").ok).toBe(true);

    const undone = await undoFleetOp(app, alice, op.value.id);
    if (!undone.ok) throw new Error(undone.error.message);
    expect(undone.value.rows.map((r) => r.outcome)).toEqual(["ok", "ok", "ok", "ok"]);
    for (const back of [iface, home, lists, search]) {
      expect(waitsFor(back)).not.toContain(gate.number);
      expect(waitedBy(back)).not.toContain(later.number);
    }
    expect(waitedBy(iface)).toEqual([feed.number]);
    expect(waitedBy(home).sort()).toEqual([feed.number, iface.number].sort());
    expect(waitedBy(search)).toEqual([iface.number]);
    expect(labelsFor(app.db, iface.id).map((l) => l.name)).toEqual(["P1 Feed"]);
    expect(labelsFor(app.db, search.id)).toEqual([]);
    expect(deferred()).toEqual([later.number]);
    expect(ready()).toEqual(
      [home, lists, shared, loose].map((i) => i.number).sort((a, b) => a - b),
    );
  });

  test("defer refuses what it cannot mean: a leaf that active work still needs, the plan's own furniture, a repository with no gate", async () => {
    const root = issue(plain, "Release");
    link(plain, root, issue(plain, "A part"));
    const before = snapshot();
    const refusal = async (repo: Repo, on: Issue): Promise<string> => {
      const op = await applyLimb(app, alice, fresh(repo), on.number, {
        action: "defer",
      });
      if (!op.ok) return op.error.code;
      return op.value.rows.map((r) => `${r.outcome}: ${r.reason}`).join("; ");
    };
    // `One home` is beneath a limb that is not deferred: that would be a loop.
    expect(await refusal(engine, home)).toBe(
      "refused: something that is not deferred waits for it: defer that instead, or unlink it first",
    );
    // An umbrella is deferred limb by limb, never as one.
    expect(await refusal(engine, feed)).toBe("bad_action");
    expect(await refusal(plain, root)).toBe(
      [
        'refused: this repository has no open issue titled "Later gate: …"',
        'refused: this repository has no open issue titled "Later gate: …"',
      ].join("; "),
    );
    expect(snapshot()).toBe(before);
  });

  test("resume: leaves first, back under a pillar and out from behind the gate; undo defers it again", async () => {
    const off = await applyLimb(app, alice, fresh(engine), iface.number, {
      action: "defer",
    });
    expect(off.ok).toBe(true);
    const unknown = previewLimb(app, alice, fresh(engine), iface.number, {
      action: "resume",
      pillar: "P9",
    });
    expect(unknown.ok && unknown.value.rows[0]).toMatchObject({
      outcome: "refused",
      reason: "no such pillar here; they are P0 Trust, P1 Feed",
    });
    const plan = previewLimb(app, alice, fresh(engine), iface.number, {
      action: "resume",
      pillar: "p0",
    });
    if (!plan.ok) throw new Error(plan.error.message);
    // Leaves first: a limb comes back from behind the gate from the bottom.
    expect(plan.value.rows.map((r) => r.label)).toEqual(
      [lists, search, home, iface].map((i) => `alice/engine#${i.number}`),
    );
    for (const row of plan.value.rows)
      expect(row).toMatchObject({
        before: [`behind #${gate.number}`, `under #${later.number}`],
        after: [`under #${trust.number}`],
        outcome: "change",
      });
    expect(plan.value.taken.map((i) => i.number)).toEqual(
      [iface, home, lists, search].map((i) => i.number),
    );
    const op = await applyLimb(app, alice, fresh(engine), iface.number, {
      action: "resume",
      pillar: "p0",
    });
    if (!op.ok) throw new Error(op.error.message);
    expect(op.value.rows.map((r) => r.outcome)).toEqual(["ok", "ok", "ok", "ok"]);
    expect(waitedBy(iface)).toEqual([trust.number]);
    for (const back of [iface, home, lists, search]) {
      expect(waitsFor(back)).not.toContain(gate.number);
      expect(waitedBy(back)).toContain(trust.number);
      expect(labelsFor(app.db, back.id).map((l) => l.name)).toEqual(["P0 Trust"]);
    }
    expect(deferred()).toEqual([later.number]);
    // Undo: deferred again, exactly as it was.
    const undone = await undoFleetOp(app, alice, op.value.id);
    expect(undone.ok && undone.value.rows.map((r) => r.outcome)).toEqual(["ok", "ok", "ok", "ok"]);
    expect(waitedBy(iface)).toEqual([later.number]);
    expect(waitsFor(home)).toContain(gate.number);
    // Resumed under no pillar: out from behind the gate, filed nowhere.
    const out = await applyLimb(app, alice, fresh(engine), iface.number, {
      action: "resume",
    });
    if (!out.ok) throw new Error(out.error.message);
    expect(out.value.rows.map((r) => [r.after, r.outcome])).toEqual(
      [lists, search, home, iface].map(() => [[], "ok"]),
    );
    expect(waitedBy(iface)).toEqual([]);
    expect(labelsFor(app.db, iface.id)).toEqual([]);
    // What resume does not touch: an issue that was not filed for later.
    // The fixture, as it was, for what follows.
    for (const under of [iface, home, lists]) link(engine, feed, under);
  });

  test("close as not doing: every open issue only the limb needs, with the reason on each; what else is needed stays; undo opens them", async () => {
    const reason = "The feed replaces these pages.";
    const plan = previewLimb(app, alice, fresh(engine), iface.number, {
      action: "close",
      reason,
    });
    if (!plan.ok) throw new Error(plan.error.message);
    // Top down, the limb first; the shared toolbar is not the limb's to drop.
    expect(plan.value.rows.map((r) => [r.label, r.before, r.after, r.outcome])).toEqual(
      [iface, home, search, lists].map((i) => [
        `alice/engine#${i.number}`,
        "open",
        "closed (dropped)",
        "change",
      ]),
    );
    expect(plan.value.kept.map((i) => i.number)).toEqual([shared.number]);
    expect(current(home).state).toBe("open");

    const op = await applyLimb(app, alice, fresh(engine), iface.number, {
      action: "close",
      reason,
    });
    if (!op.ok) throw new Error(op.error.message);
    expect(op.value.rows.map((r) => [r.label, r.outcome])).toEqual(
      plan.value.rows.map((r) => [r.label, "ok"]),
    );
    for (const closed of [iface, home, lists, search]) {
      expect(current(closed).state).toBe("closed");
      expect(current(closed).closeReason).toBe("dropped");
      expect(listComments(app.db, closed.id).at(-1)!.body).toBe(
        `Not doing: ${reason}`,
      );
    }
    expect(current(shared).state).toBe("open");
    expect(current(loose).state).toBe("open");

    const undone = await undoFleetOp(app, alice, op.value.id);
    if (!undone.ok) throw new Error(undone.error.message);
    expect(undone.value.rows.map((r) => r.outcome)).toEqual([
      "ok",
      "ok",
      "ok",
      "ok",
    ]);
    for (const opened of [iface, home, lists, search])
      expect(current(opened).state).toBe("open");
    // Once only.
    const again = await undoFleetOp(app, alice, op.value.id);
    expect(again.ok ? "undone" : again.error.code).toBe("already_undone");
  });

  test("over the API and the MCP tool: a dry run by default, the same plan, and an admin token applies and undoes", async () => {
    const path = `/api/v1/repos/alice/engine/milestones/${iface.number}/limb`;
    const admin = tokenOf(alice, "admin");
    const before = snapshot();
    const dry = await post(tokenOf(alice, "ro"), path, { action: "defer" });
    expect(dry.status).toBe(200);
    const plan = (await dry.json()) as Record<string, any>;
    expect(plan["dryRun"]).toBe(true);
    expect(plan["limb"]).toEqual({ number: iface.number, title: "One interface" });
    expect(plan["taken"].map((i: { number: number }) => i.number)).toEqual(
      [iface, home, lists, search].map((i) => i.number),
    );
    expect(plan["rows"][0].outcome).toBe("change");
    const mcp = await tool(tokenOf(alice, "ro"), {
      app: "alice/engine",
      issue: iface.number,
      action: "defer",
    });
    expect(mcp.value).toEqual(plan);
    expect(snapshot()).toBe(before);

    const applied = await post(admin, path, { action: "defer", dryRun: false });
    expect(applied.status).toBe(201);
    const receipt = (await applied.json()) as Record<string, any>;
    expect(receipt["rows"][0].outcome).toBe("ok");
    expect(deferred()).toContain(home.number);
    // The receipt is the fleet's, and so is its undo.
    const kept = await fetch(`${base}/api/v1/fleet/ops/${receipt["id"]}`, {
      headers: { authorization: `Bearer ${admin}` },
    });
    expect(kept.status).toBe(200);
    const undone = await tool(admin, {
      app: "alice/engine",
      action: "undo",
      operation: receipt["id"],
      dryRun: false,
    });
    expect(undone.value.undoOf).toBe(receipt["id"]);
    expect(snapshot()).toBe(before);
    expect(
      (await tool(admin, { app: "alice/engine", action: "undo", operation: receipt["id"] }))
        .error,
    ).toBe("invalid: undo is not a dry run: pass dryRun false");
  });

  test("on the page: the actions for an admin only, a preview before anything is written, a receipt, and one undo", async () => {
    const at = `/alice/engine/milestones/${iface.number}`;
    const mine = await (await get("alice", at)).text();
    expect(mine).toContain('id="limb-actions"');
    expect(mine).toContain(`href="${at}/limb?action=defer"`);
    expect(mine).toContain(`href="${at}/limb?action=close"`);
    // A reader sees the milestone and no way to act on it.
    const theirs = await (await get("bob", at)).text();
    expect(theirs).toContain("<h1>One interface</h1>");
    expect(theirs).not.toContain('id="limb-actions"');
    // An umbrella is not filed: it offers the close alone.
    const pillar = await (
      await get("alice", `/alice/engine/milestones/${feed.number}`)
    ).text();
    expect(pillar).toContain("limb?action=close");
    expect(pillar).not.toContain("limb?action=defer");

    const before = snapshot();
    const preview = await (await get("alice", `${at}/limb?action=defer`)).text();
    expect(preview).toContain("Defer “One interface”?");
    expect(preview).toContain("4 stop being picked");
    expect(preview).toMatch(/1 stays: something\s+outside this limb still waits for\s+it/);
    expect(preview).toContain("A shared toolbar");
    // The row is the §5 row: the issue by its title, and where it goes.
    expect(preview).toMatch(
      new RegExp(
        `<a href="/alice/engine/issues/${iface.number}"\\s+class="row"[^>]*>[\\s\\S]*?<span\\s+class="row-title"[^>]*>One interface</span`,
      ),
    );
    expect(preview).toContain(
      `under #${feed.number} → behind #${gate.number}, under #${later.number}`,
    );
    // The confirm is the §5 dialog: a same-origin POST to the limb, nothing
    // written until it is sent.
    expect(preview).toMatch(
      new RegExp(
        `<form\\s+method="post"\\s+action="${at}/limb"\\s+class="dialog"`,
      ),
    );
    expect(preview).toContain('<h2 id="limb-confirm-title">Defer this limb?</h2>');
    expect(preview).toContain("Defer this limb");
    expect(preview).not.toContain('class="limb-');
    // A close asks its reason in the dialog, as a §5 field.
    const closing = await (await get("alice", `${at}/limb?action=close`)).text();
    expect(closing).toMatch(/<label for="limb-reason">Why, in one sentence<\/label>/);
    expect(closing).toMatch(/id="limb-reason"\s+name="reason"\s+required/);
    expect(closing).toContain('maxlength="300"');
    // A reader's preview says so, and offers nothing to confirm.
    const looked = await (await get("bob", `${at}/limb?action=defer`)).text();
    expect(looked).toContain("Nothing here is yours to change.");
    expect(looked).not.toContain("Defer this limb");
    expect((await get("", `${at}/limb?action=defer`)).status).toBe(303);
    expect((await get("alice", `${at}/limb?action=burn`)).status).toBe(404);
    expect(snapshot()).toBe(before);

    // Nobody signed in, a reader, and a post from another origin write nothing.
    expect((await submit("", `${at}/limb`, { action: "defer" })).status).toBe(303);
    const readers = await submit("bob", `${at}/limb`, { action: "defer" });
    expect(readers.status).toBe(303);
    expect(
      await (await get("bob", readers.headers.get("location")!)).text(),
    ).toContain("0 written, 4 left as they were.");
    const foreign = await fetch(`${base}${at}/limb`, {
      method: "POST",
      headers: { cookie: cookies["alice"]!, origin: "https://evil.test" },
      body: new URLSearchParams({ action: "defer" }),
      redirect: "manual",
    });
    expect(foreign.status).toBe(403);
    // A close without its reason goes back to the preview.
    const bare = await submit("alice", `${at}/limb`, { action: "close" });
    expect(bare.headers.get("location")).toBe(`${at}/limb?action=close`);
    expect(snapshot()).toBe(before);

    const applied = await submit("alice", `${at}/limb`, { action: "defer" });
    expect(applied.status).toBe(303);
    const receiptAt = applied.headers.get("location")!;
    expect(receiptAt).toStartWith(`${at}/limb/`);
    expect(deferred()).toContain(home.number);
    const receipt = await (await get("alice", receiptAt)).text();
    expect(receipt).toContain("<h1>Deferred</h1>");
    expect(receipt).toContain("4 written.");
    expect(receipt).toContain(`action="${receiptAt}/undo"`);
    // The receipt is its actor's: a reader gets the one 404.
    expect((await get("bob", receiptAt)).status).toBe(404);
    // The milestone now offers Resume, and promises no date.
    const held = await (await get("alice", at)).text();
    expect(held).toContain(`href="${at}/limb?action=resume"`);
    expect(held).toContain(
      "Deferred (behind the Later gate): the crew picks nothing beneath it",
    );

    const undone = await submit("alice", `${receiptAt}/undo`, {});
    expect(undone.status).toBe(303);
    const undoneAt = undone.headers.get("location")!;
    expect(undoneAt).not.toBe(receiptAt);
    expect(await (await get("alice", undoneAt)).text()).toContain(
      "<h1>Undone</h1>",
    );
    expect(snapshot()).toBe(before);
    // The first receipt no longer offers an undo.
    expect(await (await get("alice", receiptAt)).text()).not.toContain(
      `action="${receiptAt}/undo"`,
    );
  });
});
