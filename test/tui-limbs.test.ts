/**
 * Raise and Lower in the terminal (#1514): the limbs of a repository in
 * their set order, and a move as a preview, an apply and an undo — the same
 * fleet operation the milestones page uses.
 *
 * Driven through the palette, the way a person gets there, against a real
 * forge. The refusals carry the weight: a reader sees the order and has no
 * keys to change it, a guest sees nothing private, and a move reaches the
 * outbox (and so a milestones page open on the web) as `limb.moved`.
 */
import { seatAs } from "./helpers/seat.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkIssue } from "../src/actions/dependencies.ts";
import { openIssue } from "../src/actions/issues.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import {} from "../src/core/agents.ts";
import { pendingReplans } from "../src/core/limb_replan.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { listEvents } from "../src/core/events.ts";
import { getIssueById, type Issue } from "../src/core/issues.ts";
import { readPlan } from "../src/core/milestones.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";
import { withScripts } from "./helpers/page-script.ts";

quietLogs();

describe("raise and lower a limb in the terminal", () => {
  let dataDir: string;
  let forge: Forge;
  let servers: Servers;
  let alice: User;
  let bob: User;
  let repo: Repo;
  let vault: Repo;
  let trust: Issue;
  let feed: Issue;

  const open = (r: Repo, who: User, title: string): Issue => {
    const opened = openIssue(forge, who, getRepoById(forge.db, r.id)!, { title });
    if (!opened.ok) throw new Error(String(opened.error));
    return opened.value;
  };
  const link = (r: Repo, waiter: Issue, on: Issue): void => {
    const now = (i: Issue) => getIssueById(forge.db, i.id)!;
    const linked = linkIssue(forge, alice, getRepoById(forge.db, r.id)!, now(waiter), now(on));
    if (!linked.ok) throw new Error(String(linked.error));
  };
  const top = (r: Repo = repo): number[] =>
    readPlan(forge.db, getRepoById(forge.db, r.id)!).limbs.map((l) => l.issue.number);
  const moved = () => listEvents(forge.db, { repoId: repo.id }).filter((e) => e.kind === "limb.moved");

  function boot(user?: User) {
    const terminal = headlessTerminal(120, 32);
    const identity: TuiIdentity = { sshUsername: "t", remoteAddress: "127.0.0.1", user };
    const { app } = createForgeApp(forge, identity, { terminal, exitHooks: false });
    app.start();
    const press = async (...keys: string[]) => {
      for (const key of keys) {
        const ctrl = key.startsWith("ctrl+");
        app.dispatch({ type: "key", key: ctrl ? key.slice(5) : key, ctrl, alt: false, shift: false });
      }
      await settleApp(app);
    };
    const typeText = async (text: string) => {
      for (const ch of text)
        app.dispatch({ type: "key", key: ch, ctrl: false, alt: false, shift: false });
      await settleApp(app);
    };
    const toMilestones = async (spec: string) => {
      await settleApp(app);
      await press("ctrl+k");
      await typeText("Milestones in a repository");
      await press("enter");
      await typeText(spec);
      await press("enter");
    };
    return { text: () => app.screen.toText(), press, toMilestones, stop: () => app.stop() };
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-limbs-"));
    forge = createApp({ dataDir, port: 0 });
    servers = await serve(forge);
    for (const [username, adminIfFirst] of [["alice", true], ["bob", false]] as const) {
      const made = await createUser(forge.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst,
      });
      if (!made.ok) throw new Error(made.error);
    }
    alice = getUserByName(forge.db, "alice")!;
    bob = getUserByName(forge.db, "bob")!;
    const made = await createRepo(forge, alice, { name: "order", visibility: "public" });
    const sealed = await createRepo(forge, alice, { name: "vault", visibility: "private" });
    if (!made.ok || !sealed.ok) throw new Error("repo");
    repo = made.value;
    vault = sealed.value;
    for (const [r, label] of [[repo, ""], [vault, "Secret "]] as const) {
      const a = open(r, alice, `${label}P0 Trust: agents contained`);
      const b = open(r, alice, `${label}P1 Feed: one front door`);
      const gate = open(r, alice, `${label}Later gate: nothing behind this starts`);
      const leafA = open(r, alice, `${label}A trust leaf`);
      const leafB = open(r, alice, `${label}A feed leaf`);
      link(r, gate, a);
      link(r, gate, b);
      link(r, a, leafA);
      link(r, b, leafB);
      if (r === repo) {
        trust = a;
        feed = b;
        const run = createRun(forge.db, {
          repoId: r.id,
          kind: "agent",
          issueId: leafA.id,
          actorId: alice.id,
          reason: "assigned",
        });
        claimRun(forge.db, run.id);
        finishRun(forge.db, run.id, { state: "ok", summary: "x", costUsd: 2.5 });
      }
    }
  }, 60_000);

  afterAll(async () => {
    servers.stop();
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an admin previews, applies and undoes a Lower, and the web hears it", async () => {
    expect(top().slice(0, 2)).toEqual([trust.number, feed.number]);
    const heard: string[] = [];
    const off = forge.bus.subscribe((e) => {
      if (e.kind === "limb.moved" && e.repoId === repo.id) heard.push(e.kind);
    });
    const h = boot(alice);
    await h.toMilestones("alice/order");
    expect(h.text()).toContain("Trust");
    expect(h.text()).toContain("Feed");

    // Preview first: the dialog says the new order, and nothing is written.
    await h.press("l");
    expect(h.text()).toContain("New order");
    expect(top().slice(0, 2)).toEqual([trust.number, feed.number]);
    expect(moved()).toHaveLength(0);
    // Esc backs out.
    await h.press("esc");
    expect(top().slice(0, 2)).toEqual([trust.number, feed.number]);

    // Apply.
    await h.press("l", "enter");
    expect(top().slice(0, 2)).toEqual([feed.number, trust.number]);
    expect(moved()).toHaveLength(1);
    expect(heard).toEqual(["limb.moved"]);
    expect(h.text()).toMatch(/1\. #\d+ .*Feed/);

    // Undo puts it back, once.
    await h.press("u");
    expect(top().slice(0, 2)).toEqual([trust.number, feed.number]);
    expect(moved()).toHaveLength(2);
    await h.press("u");
    expect(moved()).toHaveLength(2);
    off();
    h.stop();
  });

  test("a move made elsewhere reorders the open list without a key", async () => {
    const h = boot(alice);
    await h.toMilestones("alice/order");
    const other = boot(alice);
    await other.toMilestones("alice/order");
    await other.press("l", "enter");
    // The bus refresh is coalesced over a few tens of milliseconds.
    await new Promise((r) => setTimeout(r, 120));
    await h.press("j", "k");
    expect(h.text()).toMatch(/1\. #\d+ .*Feed/);
    await other.press("u");
    other.stop();
    h.stop();
  });

  test("a reader sees the order and has no Raise or Lower", async () => {
    const h = boot(bob);
    await h.toMilestones("alice/order");
    expect(h.text()).toContain("Trust");
    expect(h.text()).toContain("not change it");
    const before = moved().length;
    await h.press("l");
    expect(h.text()).not.toContain("New order");
    await h.press("r", "u");
    expect(moved()).toHaveLength(before);
    expect(top().slice(0, 2)).toEqual([trust.number, feed.number]);
    h.stop();
  });

  test("an owner sees what the limb under the cursor cost and landed; a reader and a guest see none", async () => {
    const h = boot(alice);
    await h.toMilestones("alice/order");
    expect(h.text()).toContain("Cost and landed: $2.50 spent · 0 changes landed");
    expect(h.text()).toContain("Costliest: #");
    expect(h.text()).toContain("$2.50");
    // The Feed limb cost nothing.
    await h.press("j");
    expect(h.text()).toContain("Cost and landed: $0.00 spent");
    expect(h.text()).toContain("Nothing has cost anything yet.");
    h.stop();

    for (const who of [bob, undefined]) {
      const r = boot(who);
      await r.toMilestones("alice/order");
      expect(r.text()).toContain("Trust");
      expect(r.text()).not.toContain("Cost and landed");
      expect(r.text()).not.toContain("$2.50");
      r.stop();
    }
  });

  test("the limb under the cursor says its pace, to a guest as to an owner", async () => {
    for (const who of [alice, undefined]) {
      const h = boot(who);
      await h.toMilestones("alice/order");
      // Nothing under Trust has closed.
      expect(h.text()).toContain("no movement in 7 days");
      h.stop();
    }
  });

  test("a guest sees a public order, never a private one, and moves nothing", async () => {
    const h = boot(undefined);
    await h.toMilestones("alice/vault");
    expect(h.text()).toContain("not found");
    expect(h.text()).not.toContain("Secret");
    h.stop();

    const g = boot(undefined);
    await g.toMilestones("alice/order");
    expect(g.text()).toContain("Trust");
    const before = moved().length;
    await g.press("l");
    expect(g.text()).not.toContain("New order");
    expect(moved()).toHaveLength(before);
    g.stop();
  });

  test("the milestones page carries the live client and hears limb.moved", async () => {
    const res = await fetch(`${servers.url}/alice/order/milestones`);
    const body = await withScripts(servers.url, await res.text());
    expect(body).toContain('id="live"');
    expect(body).toContain("limb.moved");
    // A hand-over to the planner, or taking it back, reaches an open page too.
    expect(body).toMatch(/limb\.replan[^_]/);
    expect(body).toContain("limb.replan_taken_back");
  });

  test("p hands a limb to the planner after a preview, shows it with the planner, and takes it back; a reader has no key", async () => {
    const made = await createRepo(forge, alice, { name: "plan", visibility: "public" });
    if (!made.ok) throw new Error("repo");
    const r = made.value;
    const agent = await createAgent(forge, alice, { username: "atlas" });
    if (!agent.ok) throw new Error(String(agent.error));
    addToCrew(forge, alice, r, "atlas");
    seatAs(forge.db, r.id, getUserByName(forge.db, "atlas")!.id, "planner");
    await updateRepoSettings(forge, alice, r, {
      autonomy: "autonomous",
      autonomyDirection: "Keep it small.",
      autonomyCeilingUsd: 10,
      autonomyBy: alice.id,
    });
    const search = open(r, alice, "Search everything");
    for (const t of ["Index titles", "Index bodies"]) link(r, search, open(r, alice, t));
    const pending = () => pendingReplans(forge.db, getRepoById(forge.db, r.id)!).length;

    const reader = boot(bob);
    await reader.toMilestones("alice/plan");
    await reader.press("p");
    expect(reader.text()).not.toContain("Hand to the planner");
    expect(pending()).toBe(0);
    reader.stop();

    const h = boot(alice);
    await h.toMilestones("alice/plan");
    await h.press("p");
    // The preview lists what the planner will be given; nothing is written yet.
    expect(h.text()).toContain("Index titles");
    expect(h.text()).toContain("Hand to the planner");
    expect(pending()).toBe(0);
    await h.press("esc");
    expect(pending()).toBe(0);
    await h.press("p", "enter");
    expect(pending()).toBe(1);
    expect(h.text()).toContain("with the planner");
    // Take it back while the planner has not started.
    await h.press("p");
    expect(h.text()).toContain("Take it back");
    await h.press("enter");
    expect(pending()).toBe(0);
    expect(h.text()).not.toContain("with the planner");
    h.stop();
  });
});
