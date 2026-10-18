/**
 * The order of the limbs (#1064): raise or lower a limb against its
 * siblings, and the crew takes ready work in that order.
 *
 * The refusals come first — a reader, a crew agent and a read token move
 * nothing. Then the stored order (kept across a restart), the ready order
 * that follows it, the issue beneath two limbs, the preview, the undo, and
 * every door: the page, the API and the MCP tool.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { linkIssue } from "../src/actions/dependencies.ts";
import { undoFleetOp } from "../src/actions/fleet.ts";
import { openIssue } from "../src/actions/issues.ts";
import { applyLimb, previewLimb } from "../src/actions/limbs.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { readyNow, repoGraph } from "../src/core/dependencies.ts";
import { getIssueById, type Issue } from "../src/core/issues.ts";
import { readPlan } from "../src/core/milestones.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("the order of the limbs", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let alice: User;
  let bob: User;
  let mason: User;
  let repo: Repo;
  let trust: Issue;
  let feed: Issue;
  let s1: Issue;
  let s2: Issue;
  let a1: Issue;
  let b1: Issue;
  let both: Issue;
  let x1: Issue;
  let x2: Issue;

  const fresh = () => getRepoById(app.db, repo.id)!;
  const current = (issue: Issue) => getIssueById(app.db, issue.id)!;
  const open = (title: string): Issue => {
    const opened = openIssue(app, alice, fresh(), { title });
    if (!opened.ok) throw new Error(String(opened.error));
    return opened.value;
  };
  const link = (waiter: Issue, on: Issue): void => {
    const linked = linkIssue(app, alice, fresh(), current(waiter), current(on));
    if (!linked.ok) throw new Error(String(linked.error));
  };
  const ready = (): number[] =>
    readyNow(repoGraph(app.db, repo.id)).map((r) => r.issue.number);
  const names = (...issues: Issue[]) => issues.map((i) => i.number);
  const places = (): string =>
    JSON.stringify(
      app.db
        .query("SELECT parent_id, issue_id, place FROM limb_place ORDER BY 1, 2")
        .all(),
    );
  const top = (): number[] =>
    readPlan(app.db, fresh()).limbs.map((l) => l.issue.number);
  const under = (m: Issue): number[] =>
    readPlan(app.db, fresh())
      .milestone(m.number)!
      .limbs.map((l) => l.issue.number);
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
    fetch(`${base}${path}`, { headers: { cookie: cookies[who]! }, redirect: "manual" });
  const submit = (who: string, path: string, form: Record<string, string>) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { cookie: cookies[who]!, origin: base },
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
  /** The ready order with no order set, and with feed's limbs first. */
  let NATURAL: number[] = [];
  let FEED_FIRST: number[] = [];
  const path = () => `/api/v1/repos/alice/order/milestones`;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-limb-order-"));
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
            body: new URLSearchParams({ username: name, password: "a-good-passphrase" }),
            redirect: "manual",
          })
        ).headers.get("set-cookie") ?? ""
      ).split(";")[0]!;
    const made = await createRepo(app, alice, { name: "order", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const seeded = await commitToBranch(app, alice, made.value, {
      message: "Start",
      files: [{ path: "README.md", content: "# order\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    repo = made.value;
    const agent = await createAgent(app, alice, { username: "mason" });
    if (!agent.ok) throw new Error(String(agent.error));
    expect(addToCrew(app, alice, repo, "mason").ok).toBe(true);
    mason = getUserByName(app.db, "mason")!;

    // Natural ready order: what frees most, then the oldest.
    b1 = open("A feed leaf");
    x1 = open("First sub-limb leaf");
    x2 = open("Second sub-limb leaf");
    both = open("Under both pillars");
    a1 = open("A trust leaf");
    trust = open("P0 Trust: agents contained");
    feed = open("P1 Feed: one front door");
    open("Later: work that serves no pillar now");
    const gate = open("Later gate: nothing behind this starts");
    s1 = open("First sub-limb");
    s2 = open("Second sub-limb");
    link(gate, trust);
    link(gate, feed);
    link(trust, a1);
    link(trust, both);
    link(feed, both);
    link(feed, b1);
    link(feed, s1);
    link(feed, s2);
    link(s1, x1);
    link(s2, x2);
    NATURAL = names(x1, x2, both, b1, a1);
    // An issue beneath both pillars takes the higher one.
    FEED_FIRST = names(both, b1, x1, x2, a1);
  }, 60_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("with no order set, the ready order is the one that never knew limbs", () => {
    expect(places()).toBe("[]");
    expect(ready()).toEqual(NATURAL);
    expect(top()).toEqual(names(trust, feed).concat(top().slice(2)));
  });

  test("refused: a reader, a crew agent and a read token move nothing, by any door", async () => {
    const request = { action: "raise" as const, under: "top" };
    // A reader may look: the one row comes back refused, and says why.
    const looked = previewLimb(app, bob, fresh(), feed.number, request);
    expect(looked.ok && looked.value.rows.map((r) => r.outcome)).toEqual(["refused"]);
    if (looked.ok) expect(looked.value.rows[0]!.reason).toBe("you are not an admin of alice/order");
    const tried = await applyLimb(app, bob, fresh(), feed.number, request);
    expect(tried.ok && tried.value.rows.every((r) => r.outcome === "refused")).toBe(true);
    // An agent never applies; nobody signed in does not either.
    const agent = await applyLimb(app, mason, fresh(), feed.number, request);
    expect(agent.ok ? "applied" : agent.error.code).toBe("forbidden");
    const nobody = await applyLimb(app, undefined, fresh(), feed.number, request);
    expect(nobody.ok ? "applied" : nobody.error.code).toBe("unauthorized");
    // The API: a read token, a write token and an agent's admin token.
    const url = `${path()}/${feed.number}/limb`;
    const apply = { action: "raise", under: "top", dryRun: false };
    expect((await post(tokenOf(alice, "ro"), url, apply)).status).toBe(403);
    expect((await post(tokenOf(alice, "rw"), url, apply)).status).toBe(403);
    expect((await post(tokenOf(mason, "admin"), url, apply)).status).toBe(403);
    // A reader's admin token writes nothing.
    const theirs = await post(tokenOf(bob, "admin"), url, apply);
    const rows = ((await theirs.json()) as { rows?: { outcome: string }[] }).rows;
    expect(rows?.every((r) => r.outcome === "refused") ?? true).toBe(true);
    // MCP: applying takes an admin token, whoever asks.
    const args = { app: "alice/order", issue: feed.number, action: "raise", under: "top", dryRun: false };
    for (const token of [tokenOf(alice, "ro"), tokenOf(alice, "rw"), tokenOf(mason, "rw")])
      expect((await tool(token, args)).error).toContain("forbidden");
    expect((await tool(tokenOf(mason, "admin"), args)).error).toContain("forbidden");
    // The page: a reader sees no Raise, and a posted form moves nothing.
    expect(await (await get("bob", `/alice/order/milestones`)).text()).not.toContain(">Raise<");
    const form = { action: "raise", under: "top" };
    const posted = await submit("bob", `/alice/order/milestones/${feed.number}/limb`, form);
    expect(posted.status).not.toBe(201);
    expect(places()).toBe("[]");
    expect(top().slice(0, 2)).toEqual(names(trust, feed));
    expect(ready()).toEqual(NATURAL);
  });

  test("a move that cannot be made is said, not guessed", async () => {
    const say = async (limb: Issue, request: { action: "raise" | "lower"; under?: string }) => {
      const r = await applyLimb(app, alice, fresh(), limb.number, request);
      return r.ok ? "applied" : r.error.message;
    };
    expect(await say(trust, { action: "raise", under: "top" })).toBe("it is first already");
    expect(await say(a1, { action: "raise" })).toContain("no place to move");
    expect(await say(s1, { action: "raise", under: "top" })).toContain("no place to move");
    expect(await say(feed, { action: "raise", under: "nonsense" })).toContain("under is top");
    expect(places()).toBe("[]");
  });

  test("the preview shows the new order and the top of the ready list, and writes nothing", () => {
    const plan = previewLimb(app, alice, fresh(), feed.number, { action: "raise", under: "top" });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.order!.map((i) => i.number).slice(0, 2)).toEqual(names(feed, trust));
    expect(plan.value.ready!.before.map((i) => i.number)).toEqual(NATURAL);
    // The issue beneath both pillars takes the higher, feed, so it comes
    // before the leaves of feed's sub-limbs.
    expect(plan.value.ready!.after.map((i) => i.number)).toEqual(FEED_FIRST);
    expect(plan.value.rows.map((r) => [r.before, r.after, r.outcome])).toEqual([
      [["top:2"], ["top:1"], "change"],
    ]);
    expect(places()).toBe("[]");
  });

  let receipt: string;

  test("raise: the place is stored, shown as the order, and the ready order follows it", async () => {
    const op = await applyLimb(app, alice, fresh(), feed.number, { action: "raise", under: "top" });
    expect(op.ok && op.value.rows.map((r) => r.outcome)).toEqual(["ok"]);
    if (!op.ok) return;
    receipt = op.value.id;
    expect(top().slice(0, 2)).toEqual(names(feed, trust));
    expect(ready()).toEqual(FEED_FIRST);
    expect(JSON.parse(places()).map((r: { place: number }) => r.place).sort()).toEqual([1, 2, 3]);
    // The first cannot be raised again.
    const again = await applyLimb(app, alice, fresh(), feed.number, { action: "raise", under: "top" });
    expect(again.ok ? "applied" : again.error.message).toBe("it is first already");
  });

  test("undo puts the order back, once, and the ready list follows the order shown", async () => {
    const undone = await undoFleetOp(app, alice, receipt);
    expect(undone.ok && undone.value.rows.map((r) => r.outcome)).toEqual(["ok"]);
    expect(top().slice(0, 2)).toEqual(names(trust, feed));
    // Back where it began is no order at all: the rows go and the crew's
    // ready order is the natural one again.
    expect(places()).toBe("[]");
    expect(ready()).toEqual(NATURAL);
    const twice = await undoFleetOp(app, alice, receipt);
    expect(twice.ok ? "undone" : twice.error.code).toBe("already_undone");
  });

  test("lower is the same move the other way, and among a milestone's own limbs", async () => {
    expect(under(feed)).toEqual(names(s1, s2));
    const lowered = await applyLimb(app, alice, fresh(), s1.number, { action: "lower", under: String(feed.number) });
    expect(lowered.ok).toBe(true);
    expect(under(feed)).toEqual(names(s2, s1));
    // Second sub-limb's leaf now comes before the first's.
    expect(ready().indexOf(x2.number)).toBeLessThan(ready().indexOf(x1.number));
    const last = await applyLimb(app, alice, fresh(), s1.number, { action: "lower" });
    expect(last.ok ? "applied" : last.error.message).toBe("it is last already");
    // Undoing it, though others moved since, only where it still holds.
    if (lowered.ok) await undoFleetOp(app, alice, lowered.value.id);
    expect(under(feed)).toEqual(names(s1, s2));
  });

  test("the order survives a restart", async () => {
    const raised = await applyLimb(app, alice, fresh(), feed.number, { action: "raise", under: "top" });
    expect(raised.ok).toBe(true);
    servers.stop();
    app.close();
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    expect(top().slice(0, 2)).toEqual(names(feed, trust));
    expect(ready()).toEqual(FEED_FIRST);
  });

  test("through the API and MCP: a dry run by default, an admin applies", async () => {
    const url = `${path()}/${trust.number}/limb`;
    const dry = await post(tokenOf(alice, "ro"), url, { action: "raise", under: "top" });
    expect(dry.status).toBe(200);
    const planned = (await dry.json()) as { dryRun: boolean; order: { number: number }[] };
    expect(planned.dryRun).toBe(true);
    expect(planned.order.slice(0, 2).map((i) => i.number)).toEqual(names(trust, feed));
    expect(top().slice(0, 2)).toEqual(names(feed, trust));
    const applied = await post(tokenOf(alice, "admin"), url, { action: "raise", under: "top", dryRun: false });
    expect(applied.status).toBe(201);
    expect(top().slice(0, 2)).toEqual(names(trust, feed));
    const viaTool = await tool(tokenOf(alice, "ro"), { app: "alice/order", issue: trust.number, action: "lower", under: "top" });
    expect(viaTool.value.dryRun).toBe(true);
    expect(viaTool.value.order.slice(0, 2).map((i: { number: number }) => i.number)).toEqual(names(feed, trust));
    const done = await tool(tokenOf(alice, "admin"), { app: "alice/order", issue: trust.number, action: "lower", under: "top", dryRun: false });
    expect(done.value.rows[0].outcome).toBe("ok");
    expect(top().slice(0, 2)).toEqual(names(feed, trust));
    const back = await tool(tokenOf(alice, "admin"), { app: "alice/order", action: "undo", operation: done.value.id, dryRun: false });
    expect(back.value.rows[0].outcome).toBe("ok");
    expect(top().slice(0, 2)).toEqual(names(trust, feed));
  });

  test("the page: Raise and Lower for an admin, the preview, the receipt, the undo", async () => {
    const list = await (await get("alice", "/alice/order/milestones")).text();
    expect(list).toContain("/milestones/" + feed.number + "/limb?action=raise&amp;under=top");
    expect(list).not.toContain("/milestones/" + trust.number + "/limb?action=raise");
    const page = await (await get("alice", `/alice/order/milestones/${feed.number}`)).text();
    expect(page).toContain(`/milestones/${s2.number}/limb?action=raise&amp;under=${feed.number}`);
    const preview = await (
      await get("alice", `/alice/order/milestones/${feed.number}/limb?action=raise&under=top`)
    ).text();
    expect(preview).toContain('id="limb-order"');
    expect(preview).toContain('id="limb-ready"');
    const posted = await submit("alice", `/alice/order/milestones/${feed.number}/limb`, { action: "raise", under: "top" });
    expect(posted.status).toBe(303);
    expect(top().slice(0, 2)).toEqual(names(feed, trust));
    const receiptPage = await (await get("alice", posted.headers.get("location")!)).text();
    expect(receiptPage).toContain("Moved");
    expect(receiptPage).toContain("place 2");
    const op = posted.headers.get("location")!.split("/").pop()!;
    const undo = await submit("alice", `/alice/order/milestones/${feed.number}/limb/${op}/undo`, {});
    expect(undo.status).toBe(303);
    expect(top().slice(0, 2)).toEqual(names(trust, feed));
  });
});
