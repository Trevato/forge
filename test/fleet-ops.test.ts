/**
 * Fleet operations: a query selects rows, a dry run plans each one before →
 * after and changes nothing, applying writes through the platform's own
 * actions and keeps a receipt, and undo puts back only what still holds
 * the value the operation left. The adversarial half: rows outside the
 * actor's admin are refused and named, rows they cannot read are absent,
 * a receipt is its actor's, and a read token cannot apply.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import {
  applyFleetOp,
  previewFleetOp,
  undoFleetOp,
} from "../src/actions/fleet.ts";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import {
  createRepo,
  createLabel,
  updateRepoSettings,
} from "../src/actions/repos.ts";
import { dependenciesOf } from "../src/core/dependencies.ts";
import { eventAudience } from "../src/core/event_audience.ts";
import { listEvents } from "../src/core/events.ts";
import { createIssue, getIssue, labelsFor } from "../src/core/issues.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { cancelRun, createRun, getRun, listRuns } from "../src/core/runs.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { parseQuery } from "../src/fleet/selection.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";

describe("fleet operations", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;
  let root: User;
  let engine: Repo;
  let tools: Repo;
  let bobsPublic: Repo;
  let bobsPrivate: Repo;

  const person = async (username: string, adminIfFirst = false) => {
    const made = await createUser(app.db, { origin: "seed", trusted: true,
      username,
      // Fixtures may name an account after a reserved word on purpose.
      allowReserved: true,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst,
    });
    if (!made.ok) throw new Error(made.error);
    promote(app.db, made.value);
    return made.value;
  };
  const repoOf = async (owner: User, name: string, visibility: "public" | "private") => {
    const made = await createRepo(app, owner, { name, visibility });
    if (!made.ok) throw new Error(String(made.error));
    return made.value;
  };
  const fresh = (repo: Repo) => getRepoById(app.db, repo.id)!;
  const call = (token: string, path: string, body?: unknown) =>
    fetch(`${servers.url}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-fleet-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    // The first account is the site admin; alice and bob are not.
    root = await person("root", true);
    alice = await person("alice");
    bob = await person("bob");
    engine = await repoOf(alice, "engine", "private");
    tools = await repoOf(alice, "tools", "public");
    bobsPublic = await repoOf(bob, "garden", "public");
    bobsPrivate = await repoOf(bob, "diary", "private");
    for (const repo of [engine, tools])
      await updateRepoSettings(app, alice, repo, {
        autonomy: "assisted",
        autonomyBy: alice.id,
      });
    for (const repo of [bobsPublic, bobsPrivate])
      await updateRepoSettings(app, bob, repo, {
        autonomy: "assisted",
        autonomyBy: bob.id,
      });
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the query line names a kind and field:value terms, and says what is wrong", () => {
    const q = parseQuery("repo autonomy:assisted repo:!alice/tools");
    expect(q.ok && q.value).toEqual({
      kind: "repo",
      terms: [
        { field: "autonomy", value: "assisted", negate: false, op: "=", values: ["assisted"] },
        { field: "repo", value: "alice/tools", negate: true, op: "=", values: ["alice/tools"] },
      ],
    });
    for (const bad of ["", "pulls", "repo autonomy", "repo spent:4", "run label:x"]) {
      const parsed = parseQuery(bad);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error.code).toBe("bad_query");
    }
  });

  test("a dry run plans every row before → after, refuses what is not yours, hides what you cannot see, and changes nothing", () => {
    const plan = previewFleetOp(app, alice, "repo autonomy:assisted", {
      verb: "autonomy",
      value: "off",
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const rows = Object.fromEntries(plan.value.rows.map((r) => [r.label, r]));
    expect(Object.keys(rows).sort()).toEqual([
      "alice/engine",
      "alice/tools",
      "bob/garden",
    ]);
    expect(rows["alice/engine"]).toMatchObject({
      before: "assisted",
      after: "off",
      outcome: "change",
    });
    expect(rows["bob/garden"]).toMatchObject({
      outcome: "refused",
      reason: "you are not an admin of bob/garden",
    });
    expect(plan.value.counts).toEqual({ change: 2, unchanged: 0, refused: 1 });
    expect(plan.value.reversible).toBe(true);
    expect(fresh(engine).autonomy).toBe("assisted");
  });

  test("an action is checked against the kind and its value at the boundary", () => {
    const wrongKind = previewFleetOp(app, alice, "repo", "cancel");
    expect(!wrongKind.ok && wrongKind.error.code).toBe("bad_action");
    const badSlots = previewFleetOp(app, alice, "repo", { verb: "slots", value: 99 });
    expect(!badSlots.ok && badSlots.error.code).toBe("bad_action");
    const badMode = previewFleetOp(app, alice, "repo", { verb: "autonomy", value: "yolo" });
    expect(!badMode.ok && badMode.error.code).toBe("bad_action");
    const proto = previewFleetOp(app, alice, "repo", { verb: "__proto__" });
    expect(!proto.ok && proto.error.code).toBe("bad_action");
  });

  test("apply writes each row, keeps the receipt and an event, and undo puts it back", async () => {
    const applied = await applyFleetOp(app, alice, "repo autonomy:assisted", {
      verb: "autonomy",
      value: "off",
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const op = applied.value;
    expect(op.rows.map((r) => [r.label, r.outcome])).toEqual([
      ["alice/engine", "ok"],
      ["alice/tools", "ok"],
      ["bob/garden", "refused"],
    ]);
    expect(fresh(engine).autonomy).toBe("off");
    expect(fresh(engine).autonomyBy).toBeNull();
    expect(fresh(bobsPublic).autonomy).toBe("assisted");
    const event = listEvents(app.db, { kind: "fleet.operated" }).find(
      (e) => e.kind === "fleet.operated" && e.payload.operation === op.id,
    );
    expect(event?.payload).toMatchObject({ ok: 2, refused: 1, failed: 0 });
    // It names repositories across the forge: the event is its actor's alone.
    expect(eventAudience("fleet.operated")).toBe("actor");

    const undone = await undoFleetOp(app, alice, op.id);
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    expect(undone.value.undoOf).toBe(op.id);
    expect(undone.value.rows.map((r) => [r.label, r.before, r.after, r.outcome])).toEqual([
      ["alice/engine", "off", "assisted", "ok"],
      ["alice/tools", "off", "assisted", "ok"],
    ]);
    expect(fresh(engine).autonomy).toBe("assisted");
    expect(fresh(engine).autonomyBy).toBe(alice.id);

    const twice = await undoFleetOp(app, alice, op.id);
    expect(!twice.ok && twice.error.code).toBe("already_undone");
  });

  test("undo leaves alone a row someone changed since, and says so", async () => {
    const applied = await applyFleetOp(app, alice, "repo owner:alice", {
      verb: "slots",
      value: 4,
    });
    if (!applied.ok) throw new Error(applied.error.message);
    await updateRepoSettings(app, alice, fresh(tools), { autonomySlots: 6 });
    const undone = await undoFleetOp(app, alice, applied.value.id);
    if (!undone.ok) throw new Error(undone.error.message);
    const rows = Object.fromEntries(undone.value.rows.map((r) => [r.label, r]));
    expect(rows["alice/engine"]?.outcome).toBe("ok");
    expect(rows["alice/tools"]).toMatchObject({
      outcome: "refused",
      reason: "changed since: it is 6 now",
    });
    expect(fresh(engine).autonomySlots).toBe(1);
    expect(fresh(tools).autonomySlots).toBe(6);
  });

  test("issues: close, label, assign and link, each undone exactly", async () => {
    const opened = [1, 2, 3].map((n) => {
      const made = openIssue(app, alice, engine, { title: `Task ${n}` });
      if (!made.ok) throw new Error(String(made.error));
      return made.value;
    });
    createLabel(app, alice, engine, "urgent", "ff0000");
    const q = "issue repo:alice/engine state:open number:!3";

    const label = await applyFleetOp(app, alice, q, { verb: "label", value: "urgent" });
    if (!label.ok) throw new Error(label.error.message);
    expect(label.value.rows.map((r) => r.after)).toEqual([["urgent"], ["urgent"]]);
    expect(labelsFor(app.db, opened[0]!.id).map((l) => l.name)).toEqual(["urgent"]);

    const missing = previewFleetOp(app, alice, q, { verb: "label", value: "nope" });
    expect(missing.ok && missing.value.rows[0]?.reason).toBe(
      "no label named nope in alice/engine",
    );

    const link = await applyFleetOp(app, alice, q, { verb: "link", value: 3 });
    if (!link.ok) throw new Error(link.error.message);
    expect(dependenciesOf(app.db, opened[0]!.id).blockedBy.map((i) => i.number)).toEqual([3]);

    const assign = await applyFleetOp(app, alice, q, { verb: "assign", value: "alice" });
    if (!assign.ok) throw new Error(assign.error.message);
    expect(getIssue(app.db, engine.id, 1)?.assigneeName).toBe("alice");
    // bob cannot read alice's private engine: assigning him is refused per row.
    const toBob = previewFleetOp(app, alice, q, { verb: "assign", value: "bob" });
    expect(toBob.ok && toBob.value.counts.refused).toBe(2);

    const close = await applyFleetOp(app, alice, q, "close");
    if (!close.ok) throw new Error(close.error.message);
    expect(getIssue(app.db, engine.id, 1)?.state).toBe("closed");

    for (const op of [close, assign, link, label]) {
      if (!op.ok) continue;
      const undone = await undoFleetOp(app, alice, op.value.id);
      expect(undone.ok && undone.value.rows.every((r) => r.outcome === "ok")).toBe(true);
    }
    expect(getIssue(app.db, engine.id, 1)?.state).toBe("open");
    expect(getIssue(app.db, engine.id, 1)?.assigneeName).toBeNull();
    expect(dependenciesOf(app.db, opened[0]!.id).blockedBy).toEqual([]);
    expect(labelsFor(app.db, opened[0]!.id)).toEqual([]);
  });

  test("runs: cancel is final, requeue puts an agent's task back on the queue", async () => {
    const agent = await createAgent(app, root, { username: "helper", model: "", brief: "" });
    if (!agent.ok) throw new Error(String(agent.error));
    addToCrew(app, root, tools, "helper");
    const issue = openIssue(app, alice, tools, { title: "Runs for the fleet" });
    if (!issue.ok) throw new Error(String(issue.error));
    assignIssue(app, alice, tools, issue.value, agent.value.user);
    const queued = createRun(app.db, {
      repoId: tools.id,
      kind: "agent",
      issueId: issue.value.id,
      actorId: agent.value.user.id,
      reason: "assigned",
    });
    const deploy = createRun(app.db, { repoId: tools.id, kind: "deploy" });
    cancelRun(app.db, deploy.id);

    const cancel = await applyFleetOp(app, alice, "run repo:alice/tools state:queued", "cancel");
    if (!cancel.ok) throw new Error(cancel.error.message);
    expect(cancel.value.reversible).toBe(false);
    expect(cancel.value.rows.map((r) => r.targetId)).toContain(queued.id);
    expect(getRun(app.db, queued.id)?.state).toBe("cancelled");
    const undo = await undoFleetOp(app, alice, cancel.value.id);
    expect(!undo.ok && undo.error.code).toBe("not_reversible");

    const requeue = await applyFleetOp(
      app,
      alice,
      "run repo:alice/tools state:cancelled",
      "requeue",
    );
    if (!requeue.ok) throw new Error(requeue.error.message);
    const byId = Object.fromEntries(requeue.value.rows.map((r) => [r.targetId, r]));
    expect(byId[queued.id]?.outcome).toBe("ok");
    expect(byId[deploy.id]).toMatchObject({
      outcome: "refused",
      reason: "only an agent run is queued again",
    });
    const again = listRuns(app.db, tools.id, { kind: "agent" }).filter(
      (r) => r.state === "queued" && r.issueId === issue.value.id,
    );
    expect(again.length).toBe(1);
  });

  test("an agent may look but never apply", async () => {
    const agent = await createAgent(app, root, { username: "looker", model: "", brief: "" });
    if (!agent.ok) throw new Error(String(agent.error));
    const looked = previewFleetOp(app, agent.value.user, "repo", { verb: "slots", value: 2 });
    expect(looked.ok).toBe(true);
    const applied = await applyFleetOp(app, agent.value.user, "repo", { verb: "slots", value: 2 });
    expect(!applied.ok && applied.error.code).toBe("forbidden");
  });

  test("more rows than an operation takes is refused, not cut", () => {
    for (let n = 0; n < 501; n++)
      createIssue(app.db, { repoId: tools.id, authorId: alice.id, title: `bulk ${n}` });
    const plan = previewFleetOp(app, alice, "issue repo:alice/tools", "close");
    expect(!plan.ok && plan.error.code).toBe("too_many");
  });

  test("over HTTP: a dry run by default, a read token cannot apply, and a receipt is its actor's", async () => {
    const ro = createToken(app.db, alice.id, "ro", "ro").token;
    const rw = createToken(app.db, alice.id, "rw", "rw").token;
    const admin = createToken(app.db, alice.id, "admin", "admin").token;
    const bobs = createToken(app.db, bob.id, "bob", "admin").token;
    const action = { verb: "ceiling", value: 7.5 };
    const query = "repo owner:alice";

    const dry = await call(ro, "/api/v1/fleet/ops", { query, action });
    expect(dry.status).toBe(200);
    const plan = (await dry.json()) as { dryRun: boolean; rows: unknown[] };
    expect(plan.dryRun).toBe(true);
    expect(plan.rows.length).toBe(2);
    expect(fresh(engine).autonomyCeilingUsd).toBe(20);

    for (const token of [ro, rw]) {
      const refused = await call(token, "/api/v1/fleet/ops", { query, action, dryRun: false });
      expect(refused.status).toBe(403);
    }
    const applied = await call(admin, "/api/v1/fleet/ops", { query, action, dryRun: false });
    expect(applied.status).toBe(201);
    const op = (await applied.json()) as { id: string; dryRun: boolean };
    expect(op.dryRun).toBe(false);
    expect(fresh(engine).autonomyCeilingUsd).toBe(7.5);

    expect((await call(ro, `/api/v1/fleet/ops/${op.id}`)).status).toBe(200);
    expect((await call(bobs, `/api/v1/fleet/ops/${op.id}`)).status).toBe(404);
    expect((await call(bobs, `/api/v1/fleet/ops/${op.id}/undo`, {})).status).toBe(404);
    const list = (await (await call(ro, "/api/v1/fleet/ops")).json()) as {
      items: { id: string }[];
    };
    expect(list.items[0]?.id).toBe(op.id);

    const undo = await call(admin, `/api/v1/fleet/ops/${op.id}/undo`, {});
    expect(undo.status).toBe(201);
    expect(fresh(engine).autonomyCeilingUsd).toBe(20);
    expect((await call(admin, `/api/v1/fleet/ops/${op.id}/undo`, {})).status).toBe(409);

    const bad = await call(ro, "/api/v1/fleet/ops", { query: "nonsense", action });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { error: string }).error).toBe("bad_query");
  });
});
