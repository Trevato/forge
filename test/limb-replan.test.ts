/**
 * A limb handed to the planner (#761). The refusals come first: a reader, a
 * crew agent and an `ro` token cannot hand a limb over, and the hand-over
 * grants the planner nothing outside the limb. Then the hand-over itself:
 * owed once, even with a full map and after a decline; the brief lists the
 * limb; nothing beneath is picked until the planner answers; the planner
 * closes only as split into what is new; a person takes it back before it
 * runs; the milestone shows the change.
 */
import { seatAs } from "./helpers/seat.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { linkIssue } from "../src/actions/dependencies.ts";
import { openIssue, setIssueState } from "../src/actions/issues.ts";
import { previewReplan, replanLimb, takeBackLimb } from "../src/actions/limb_replan.ts";
import { createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import {} from "../src/core/agents.ts";
import { readyNow, repoGraph } from "../src/core/dependencies.ts";
import { getIssueById, type Issue } from "../src/core/issues.ts";
import { pendingReplans, replanSince } from "../src/core/limb_replan.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { cancelRun, claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { taskPrompt } from "../src/crew/brief.ts";
import { driveRepo, ensureDirectionIssue } from "../src/crew/autonomy.ts";
import { heldNow } from "../src/crew/held.ts";
import { handedLimbs } from "../src/crew/handed_limbs.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("a limb handed to the planner", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let alice: User;
  let bob: User;
  let mason: User;
  let atlas: User;
  let repo: Repo;
  let limb: Issue;
  let leaves: Issue[];
  let outside: Issue;
  let direction: Issue;
  const cookies: Record<string, string> = {};

  const fresh = () => getRepoById(app.db, repo.id)!;
  const current = (i: Issue) => getIssueById(app.db, i.id)!;
  const open = (title: string, by: User = alice): Issue => {
    const made = openIssue(app, by, fresh(), { title });
    if (!made.ok) throw new Error(String(made.error));
    return made.value;
  };
  const tick = () => Bun.sleep(5);
  /** A planning pass on the direction: queued, claimed, ended. */
  const planned = (state: "ok" | "failed", summary: string) => {
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: direction.id,
      actorId: atlas.id,
      reason: "assigned",
    });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, { state, summary });
    return run;
  };
  const tokenOf = (user: User, scope: "ro" | "rw" | "admin") =>
    createToken(app.db, user.id, scope, scope).token;
  const post = (token: string, path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const page = (who: string, path: string) =>
    fetch(`${base}${path}`, { headers: { cookie: cookies[who]! }, redirect: "manual" });
  const submit = (who: string, path: string, form: Record<string, string>) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { cookie: cookies[who]!, origin: base },
      body: new URLSearchParams(form),
      redirect: "manual",
    });
  const brief = (limbs: ReturnType<typeof handedLimbs>) =>
    taskPrompt({
      agent: { user: atlas } as never,
      repo: fresh(),
      issue: current(direction),
      branch: "atlas/1-direction",
      forgeUrl: base,
      isApp: false,
      resuming: false,
      role: "planner",
      reason: "assigned",
      comments: [],
      reviews: [],
      reviewComments: [],
      since: direction.createdAt,
      limbs,
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-limb-replan-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    for (const [username, adminIfFirst] of [["alice", true], ["bob", false]] as const) {
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
    const made = await createRepo(app, alice, { name: "engine", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    for (const name of ["atlas", "mason"]) {
      const agent = await createAgent(app, alice, { username: name });
      if (!agent.ok) throw new Error(String(agent.error));
      expect(addToCrew(app, alice, repo, name).ok).toBe(true);
    }
    atlas = getUserByName(app.db, "atlas")!;
    mason = getUserByName(app.db, "mason")!;
    seatAs(app.db, repo.id, atlas.id, "planner");
    const set = await updateRepoSettings(app, alice, repo, {
      autonomy: "autonomous",
      autonomyDirection: "Keep the engine small.",
      autonomyCeilingUsd: 100,
      autonomyBy: alice.id,
    });
    if (!set.ok) throw new Error(JSON.stringify(set.error));
    // The limb waits for four small leaves; four more issues fill the map.
    limb = open("Search");
    leaves = ["Index titles", "Index bodies", "Rank hits", "Highlight hits"].map((t) => open(t));
    for (const leaf of leaves) linkIssue(app, alice, fresh(), current(limb), current(leaf));
    outside = open("Unrelated work");
    for (const t of ["Filler one", "Filler two", "Filler three"]) open(t);
    direction = ensureDirectionIssue(app, alice, fresh())!;
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a reader, a crew agent and an ro token cannot hand a limb over", async () => {
    for (const who of [bob, mason, atlas, undefined]) {
      const refused = replanLimb(app, who, fresh(), limb.number);
      expect(refused.ok).toBe(false);
    }
    expect(takeBackLimb(app, bob, fresh(), limb.number).ok).toBe(false);
    expect(pendingReplans(app.db, fresh())).toEqual([]);
    const path = `/api/v1/repos/alice/engine/milestones/${limb.number}/limb`;
    // A read token plans and changes nothing, even when it asks to apply.
    expect((await post(tokenOf(alice, "ro"), path, { action: "replan", dryRun: false })).status).toBe(403);
    expect((await post(tokenOf(alice, "rw"), path, { action: "replan", dryRun: false })).status).toBe(403);
    const dry = await post(tokenOf(alice, "ro"), path, { action: "replan" });
    expect(dry.status).toBe(200);
    const body = (await dry.json()) as { dryRun: boolean; issues: { number: number }[] };
    expect(body.dryRun).toBe(true);
    expect(body.issues.map((i) => i.number).sort()).toEqual(
      [limb, ...leaves].map((i) => i.number).sort(),
    );
    const rpc = await post(tokenOf(alice, "ro"), "/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "limb",
        arguments: { app: "alice/engine", issue: limb.number, action: "replan", dryRun: false },
      },
    });
    expect(JSON.stringify(await rpc.json())).toContain("forbidden");
    // A reader's button and form do nothing.
    expect((await submit("bob", `/alice/engine/milestones/${limb.number}/limb`, { action: "replan" })).status).toBe(409);
    const said = await submit("bob", `/alice/engine/milestones/${limb.number}/limb`, { action: "replan" });
    expect(await said.text()).toContain("only a person who administers this app");
    expect(pendingReplans(app.db, fresh())).toEqual([]);
    expect(await (await page("bob", `/alice/engine/milestones/${limb.number}`)).text()).not.toContain("Re-plan");
  });

  test("the preview lists every issue the planner will be given, and writes nothing", async () => {
    const seen = previewReplan(app, bob, fresh(), limb.number);
    expect(seen.ok && seen.value.issues.map((i) => i.number)).toEqual(
      expect.arrayContaining([limb, ...leaves].map((i) => i.number)),
    );
    expect(seen.ok && seen.value.issues.some((i) => i.number === outside.number)).toBe(false);
    const html = await (await page("alice", `/alice/engine/milestones/${limb.number}/limb?action=replan`)).text();
    for (const leaf of leaves) expect(html).toContain(leaf.title);
    expect(html).not.toContain("Unrelated work");
    expect(html).toContain("Hand to the planner");
    expect(await (await page("alice", `/alice/engine/milestones/${limb.number}`)).text()).toContain("Re-plan");
    expect(pendingReplans(app.db, fresh())).toEqual([]);
  });

  test("owed once, with a full map and after a decline; the brief lists the limb", async () => {
    // The planner declined the direction and nobody has answered; the map is full.
    planned("failed", "declined: nothing to add");
    await tick();
    expect(readyNow(repoGraph(app.db, repo.id, { sealed: true })).length).toBeGreaterThanOrEqual(3);
    const done = replanLimb(app, alice, fresh(), limb.number);
    expect(done.ok).toBe(true);
    expect(replanLimb(app, alice, fresh(), limb.number).ok).toBe(false);
    await driveRepo(app, fresh());
    expect(current(direction).assigneeId).toBe(atlas.id);
    const told = brief(handedLimbs(app, fresh()));
    expect(told).toContain(`Limb #${limb.number} Search, 4 open issues`);
    for (const leaf of leaves) expect(told).toContain(`#${leaf.number} ${leaf.title}`);
    expect(told).not.toContain("Unrelated work");
    expect(told).toContain('"reason":"split"');
    expect(brief([])).not.toContain("A person handed you these limbs");
    // The pass is owed once: with its run begun, the next tick does not ask again.
    planned("ok", "re-planning");
    expect(pendingReplans(app.db, fresh())).toEqual([]);
  });

  test("until the planner answers nothing beneath the limb is picked, and the page says so", async () => {
    await tick();
    const second = replanLimb(app, alice, fresh(), limb.number);
    expect(second.ok).toBe(true);
    const startable = () => heldNow(app, fresh()).startable.map((r) => r.issue.number);
    for (const leaf of leaves) expect(startable()).not.toContain(leaf.number);
    expect(heldNow(app, fresh()).by.with_planner.length).toBe(4);
    expect(startable()).toContain(outside.number);
    const html = await (await page("bob", `/alice/engine/milestones/${limb.number}`)).text();
    expect(html).toContain("With the planner");
    expect(html).not.toContain("Re-plan");
    // A reader cannot take it back; a person can, before the planner runs.
    expect(takeBackLimb(app, bob, fresh(), limb.number).ok).toBe(false);
    expect(await (await page("alice", `/alice/engine/milestones/${limb.number}`)).text()).toContain("Take it back");
    expect(takeBackLimb(app, alice, fresh(), limb.number).ok).toBe(true);
    expect(pendingReplans(app.db, fresh())).toEqual([]);
    expect(startable()).toContain(leaves[0]!.number);
    expect(takeBackLimb(app, alice, fresh(), limb.number).ok).toBe(false);
  });

  test("the planner may close beneath the limb only as split into what is new; nothing outside", async () => {
    await tick();
    const old = open("Made before the hand-over", atlas);
    await tick();
    expect(replanLimb(app, alice, fresh(), limb.number).ok).toBe(true);
    await tick();
    const [a, b] = leaves.map((l) => current(l));
    expect(replanSince(app.db, fresh(), a!)).toBeDefined();
    expect(replanSince(app.db, fresh(), current(outside))).toBeUndefined();
    const close = (i: Issue, closing: Parameters<typeof setIssueState>[5]) =>
      setIssueState(app, atlas, fresh(), current(i), "closed", closing);
    // Not dropped, not into an older issue, not without a piece.
    expect(close(a!, { reason: "dropped" }).ok).toBe(false);
    expect(close(a!, { reason: "split", into: [old.number] }).ok).toBe(false);
    expect(close(a!, { reason: "split", into: [] }).ok).toBe(false);
    expect(current(a!).state).toBe("open");
    // A person's issue outside the limb is not the planner's to drop.
    expect(close(outside, { reason: "dropped" }).ok).toBe(false);
    expect(current(outside).state).toBe("open");
    const larger = open("Search over titles and bodies", atlas);
    expect(close(a!, { reason: "split", into: [larger.number] }).ok).toBe(true);
    expect(close(b!, { reason: "split", into: [larger.number] }).ok).toBe(true);
    // Once it has answered, the grant is gone.
    planned("ok", "re-planned");
    expect(replanSince(app.db, fresh(), current(leaves[2]!))).toBeUndefined();
    expect(pendingReplans(app.db, fresh())).toEqual([]);
  });

  test("afterwards the milestone shows which issues were closed into which", async () => {
    const html = await (await page("bob", `/alice/engine/milestones/${limb.number}`)).text();
    expect(html).toContain("Re-planned");
    expect(html).toContain("closed as split into");
    expect(html).toContain(leaves[0]!.title);
    expect(html).toContain("Search over titles and bodies");
    expect(html).not.toContain("With the planner");
  });

  test("a reader and a guest never see a sealed report's title on the milestone page", async () => {
    const path = `/alice/engine/milestones/${limb.number}`;
    const seen = async (who: string | undefined) =>
      (await fetch(`${base}${path}`, { headers: who ? { cookie: cookies[who]! } : {} })).text();
    const seal = (i: Issue) => app.db.query("UPDATE issue SET sealed = 1 WHERE id = ?1").run(i.id);
    // Sealed while it is split from the limb: the old issue is not named.
    seal(leaves[1]!);
    for (const who of ["bob", undefined]) {
      const html = await seen(who);
      expect(html).toContain("closed as split into");
      expect(html).not.toContain(leaves[1]!.title);
    }
    // Sealed as the piece it was split into: the new issue is not named.
    const larger = app.db
      .query<{ id: string }, [string]>("SELECT id FROM issue WHERE repo_id = ?1 AND title = 'Search over titles and bodies'")
      .get(repo.id)!;
    app.db.query("UPDATE issue SET sealed = 1 WHERE id = ?1").run(larger.id);
    for (const who of ["bob", undefined]) expect(await seen(who)).not.toContain("Search over titles and bodies");
  });

  test("a viewer who cannot administer sees the refusal in place of the button", async () => {
    const html = await (await page("bob", `/alice/engine/milestones/${limb.number}/limb?action=replan`)).text();
    expect(html).toContain("only a person who administers this app");
    expect(html).not.toContain("Hand to the planner");
    const seen = previewReplan(app, bob, fresh(), limb.number);
    expect(seen.ok && seen.value.blocked).toContain("administers");
  });

  test("the preview says 1 issue, not 1 issues", async () => {
    const solo = open("Solo limb");
    const html = await (await page("alice", `/alice/engine/milestones/${solo.number}/limb?action=replan`)).text();
    expect(html).toContain("1 issue the planner");
    expect(html).not.toContain("1 issues");
  });

  test("a take-back is refused once the planner has been given the limb", async () => {
    await tick();
    expect(replanLimb(app, alice, fresh(), limb.number).ok).toBe(true);
    await tick();
    createRun(app.db, { repoId: repo.id, kind: "agent", issueId: direction.id, actorId: atlas.id, reason: "assigned" });
    const seen = previewReplan(app, alice, fresh(), limb.number);
    expect(seen.ok && seen.value.takeBack).toBe(false);
    expect(takeBackLimb(app, alice, fresh(), limb.number).ok).toBe(false);
  });

  test("a planning run that is cancelled leaves the limb takeable back and owed again", async () => {
    const runs = () =>
      app.db
        .query<{ id: string; state: string }, [string]>(
          "SELECT id, state FROM run WHERE issue_id = ?1 AND kind = 'agent'",
        )
        .all(direction.id);
    expect(pendingReplans(app.db, fresh()).length).toBe(1);
    for (const r of runs()) if (r.state === "queued" || r.state === "running") cancelRun(app.db, r.id);
    const seen = previewReplan(app, alice, fresh(), limb.number);
    expect(seen.ok && seen.value.takeBack).toBe(true);
    expect(pendingReplans(app.db, fresh()).length).toBe(1);
    const asked = () =>
      app.db
        .query<{ n: number }, [string, number]>(
          "SELECT COUNT(*) AS n FROM event WHERE repo_id = ?1 AND kind = 'issue.assigned' AND json_extract(payload, '$.number') = ?2",
        )
        .get(repo.id, direction.number)!.n;
    const before = asked();
    // One action a tick: the planner is asked within a few.
    for (let n = 0; n < 4 && asked() === before; n++) await driveRepo(app, fresh());
    expect(asked()).toBeGreaterThan(before);
  });
});
