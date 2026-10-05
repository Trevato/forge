/**
 * A plan says what each issue is for (#612). Where a repository has pillars,
 * the `plan` tool refuses an item that names none unless it is for later; a
 * pillar item opens under its umbrella, a later item behind the Later gate
 * with the sentence that says why, and the map shows each where it stands.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { addDependency } from "../src/core/dependencies.ts";
import {
  createIssue,
  getIssue,
  setIssueState,
  type Issue,
} from "../src/core/issues.ts";
import { findPillar, pillarsOf } from "../src/core/pillars.ts";
import type { Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { systemPrompt } from "../src/crew/brief.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("a plan says what each issue is for", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let alice: User;
  let rw: string;
  /** A repository with two pillars, a Later umbrella and the gate. */
  let forge: Repo;
  /** A repository whose direction names no pillars. */
  let lamp: Repo;
  let trust: Issue;
  let feed: Issue;
  let later: Issue;
  let gate: Issue;
  let nextId = 1;

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
      ? { error: text, value: undefined }
      : { error: undefined, value: JSON.parse(text) };
  };
  const plan = (app: string, issues: unknown[]) =>
    tool("plan", { app, issues });
  const mapOf = async (app: string) => (await tool("map", { app })).value;
  const open = (repo: Repo, title: string): Issue => {
    const made = createIssue(app.db, {
      repoId: repo.id,
      authorId: alice.id,
      title,
      body: "",
    });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };
  const repo = async (name: string): Promise<Repo> => {
    const made = await createRepo(app, alice, { name, visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    return made.value;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-pillars-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const a = await createUser(app.db, {
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    rw = createToken(app.db, alice.id, "rw", "rw").token;
    forge = await repo("forge");
    lamp = await repo("lamp");
    trust = open(forge, "P0 Trust: agents contained, every pull reviewed");
    feed = open(forge, "P1 Feed: one front door");
    later = open(forge, "Later: work that serves no pillar now");
    gate = open(forge, "Later gate: nothing behind this starts until opened");
    // As the owner keeps it: the gate waits for every pillar, so it cannot
    // open by drift.
    for (const umbrella of [trust, feed])
      if (!addDependency(app.db, gate, umbrella, alice.id).ok)
        throw new Error("could not hold the gate");
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the pillars are the open umbrellas, in order, with the gate and the Later umbrella apart", () => {
    const read = pillarsOf(app.db, forge.id);
    expect(
      read.pillars.map((p) => [p.short, p.name, p.umbrella.number]),
    ).toEqual([
      ["P0", "P0 Trust", trust.number],
      ["P1", "P1 Feed", feed.number],
    ]);
    expect(read.gate?.number).toBe(gate.number);
    expect(read.later?.number).toBe(later.number);
    expect(findPillar(read.pillars, " p1 ")?.name).toBe("P1 Feed");
    expect(findPillar(read.pillars, "p0 trust")?.short).toBe("P0");
    expect(findPillar(read.pillars, "Trust")).toBeUndefined();
    expect(pillarsOf(app.db, lamp.id)).toEqual({
      pillars: [],
      gate: undefined,
      later: undefined,
    });
  });

  test("an item that names no pillar is refused by name, with the pillars there are, and nothing opens", async () => {
    const before = (await mapOf("alice/forge")).issues.length;
    const refused = await plan("alice/forge", [
      { key: "sandbox", title: "Contain the agent", pillar: "P0" },
      { key: "slider", title: "The profit slider" },
    ]);
    expect(refused.error).toContain("no_pillar");
    expect(refused.error).toContain(
      '"slider" names no pillar: give it P0 Trust or P1 Feed, or later: true and why',
    );
    expect((await mapOf("alice/forge")).issues.length).toBe(before);
  });

  test("an item with a pillar opens under its umbrella, and is ready when nothing else holds it", async () => {
    const done = await plan("alice/forge", [
      { key: "sandbox", title: "Contain the agent", pillar: "p0" },
      {
        key: "timeline",
        title: "A timeline of what merged",
        pillar: "P1 Feed",
        blockedBy: ["sandbox"],
      },
    ]);
    expect(done.error).toBeUndefined();
    const n = Object.fromEntries(
      done.value.opened.map((o: any) => [o.key, o.number]),
    );
    expect(done.value.later).toEqual([]);
    expect(done.value.says).not.toContain("Later gate");
    expect(done.value.ready).toContain(n.sandbox);
    expect(done.value.ready).not.toContain(n.timeline);
    const map = await mapOf("alice/forge");
    expect(map.edges).toContainEqual({
      issue: trust.number,
      blockedBy: n.sandbox,
    });
    expect(map.edges).toContainEqual({
      issue: feed.number,
      blockedBy: n.timeline,
    });
    // A pillar issue says nothing about later.
    expect(getIssue(app.db, forge.id, n.sandbox)?.body).toBe("");
  });

  test("an item for later waits behind the gate, stands under the Later umbrella, and opens with why", async () => {
    const done = await plan("alice/forge", [
      {
        key: "slider",
        title: "The profit slider",
        body: "One control trading cost against responsiveness.",
        later: true,
        why: "  Money lines serve\n no pillar now. ",
      },
      {
        key: "bare",
        title: "Repo transfer",
        later: true,
        why: "Nobody asked this week.",
      },
      { key: "review", title: "Every agent pull is reviewed", pillar: "P0" },
    ]);
    expect(done.error).toBeUndefined();
    const n = Object.fromEntries(
      done.value.opened.map((o: any) => [o.key, o.number]),
    );
    expect(done.value.later).toEqual([n.slider, n.bare]);
    expect(done.value.says).toEndWith(
      `#${n.slider}, #${n.bare} wait behind the Later gate #${gate.number}.`,
    );
    expect(done.value.ready).toContain(n.review);
    expect(done.value.ready).not.toContain(n.slider);
    expect(done.value.ready).not.toContain(n.bare);
    const map = await mapOf("alice/forge");
    for (const deferred of [n.slider, n.bare]) {
      expect(map.edges).toContainEqual({
        issue: deferred,
        blockedBy: gate.number,
      });
      expect(map.edges).toContainEqual({
        issue: later.number,
        blockedBy: deferred,
      });
    }
    expect(getIssue(app.db, forge.id, n.slider)?.body).toBe(
      "**Later:** Money lines serve no pillar now.\n\nOne control trading cost against responsiveness.",
    );
    expect(getIssue(app.db, forge.id, n.bare)?.body).toBe(
      "**Later:** Nobody asked this week.",
    );
  });

  test("the map page draws the deferred issue blocked and the pillar issue ready", async () => {
    const cookie = (
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
    const page = await (
      await fetch(`${base}/alice/forge/map`, { headers: { cookie } })
    ).text();
    const card = (title: string) =>
      page.match(
        new RegExp(
          `<a[^>]*class="map-node"[^>]*>(?:(?!</a>)[\\s\\S])*${title}`,
        ),
      )?.[0] ?? "";
    expect(card("The profit slider")).toContain('data-state="blocked"');
    expect(card("Repo transfer")).toContain('data-state="blocked"');
    expect(card("Contain the agent")).toContain('data-state="ready"');
    expect(card("Later gate")).toContain('data-state="blocked"');
  });

  test("later needs its one sentence, and an item is for a pillar or for later, not both", async () => {
    const one = (item: Record<string, unknown>) =>
      plan("alice/forge", [{ key: "x", title: "X", ...item }]);
    expect((await one({ later: true })).error).toContain("no_reason");
    expect((await one({ later: true, why: "  " })).error).toContain(
      "no_reason",
    );
    expect((await one({ later: true, why: "w".repeat(301) })).error).toContain(
      "why_too_long",
    );
    expect(
      (await one({ later: true, why: "Not now.", pillar: "P0" })).error,
    ).toContain("it is one or the other");
    expect((await one({ pillar: "P0", why: "Not now." })).error).toContain(
      "why goes with later: true",
    );
    expect((await one({ later: "yes", why: "Not now." })).error).toContain(
      "later is true or false",
    );
    expect((await one({ pillar: "" })).error).toContain(
      "pillar is the name of a pillar",
    );
  });

  test("work for a pillar cannot wait on the gate, or on work that is for later", async () => {
    const before = (await mapOf("alice/forge")).issues.length;
    const onGate = await plan("alice/forge", [
      { key: "x", title: "X", pillar: "P0", blockedBy: [gate.number] },
    ]);
    expect(onGate.error).toContain('"x" cannot serve P0 Trust: cycle');
    const onLater = await plan("alice/forge", [
      { key: "a", title: "A", later: true, why: "Not now." },
      { key: "b", title: "B", pillar: "P0", blockedBy: ["a"] },
    ]);
    expect(onLater.error).toContain('"b" cannot serve P0 Trust: cycle');
    expect((await mapOf("alice/forge")).issues.length).toBe(before);
  });

  test("a pillar the repository does not have is refused, with the ones it has", async () => {
    const refused = await plan("alice/forge", [
      { key: "x", title: "X", pillar: "P9 Moon" },
    ]);
    expect(refused.error).toContain("unknown_pillar");
    expect(refused.error).toContain(
      '"P9 Moon" is not a pillar here; they are P0 Trust or P1 Feed',
    );
  });

  test("a repository with no pillars plans as it always did, has none to serve and no gate to wait behind", async () => {
    const plain = await plan("alice/lamp", [
      { key: "a", title: "Wire the switch" },
      { key: "b", title: "Fit the shade", blockedBy: ["a"] },
    ]);
    expect(plain.error).toBeUndefined();
    expect(plain.value.later).toEqual([]);
    expect(plain.value.opened).toHaveLength(2);
    const before = (await mapOf("alice/lamp")).issues.length;
    expect(
      (await plan("alice/lamp", [{ key: "c", title: "C", pillar: "P0" }]))
        .error,
    ).toContain("this repository has no pillars to serve");
    const waiting = await plan("alice/lamp", [
      { key: "c", title: "C", later: true, why: "Not now." },
    ]);
    expect(waiting.error).toContain("no_later_gate");
    expect((await mapOf("alice/lamp")).issues.length).toBe(before);
  });

  test("a pillar whose umbrella is closed is no longer one", async () => {
    setIssueState(app.db, feed.id, "closed", "done");
    expect(pillarsOf(app.db, forge.id).pillars.map((p) => p.short)).toEqual([
      "P0",
    ]);
    const refused = await plan("alice/forge", [
      { key: "x", title: "X", pillar: "P1" },
    ]);
    expect(refused.error).toContain(
      '"P1" is not a pillar here; they are P0 Trust',
    );
  });
});

describe("the planner's brief", () => {
  const brief = (role: "planner" | "builder") =>
    systemPrompt({
      agent: { user: { username: "atlas", displayName: "Atlas" }, brief: "" },
      repo: { ownerName: "alice", name: "forge", defaultBranch: "main" },
      issue: { number: 1 },
      branch: "atlas/1-direction",
      forgeUrl: "https://forge.example",
      isApp: false,
      resuming: false,
      role,
    } as unknown as Parameters<typeof systemPrompt>[0]);

  test("tells the planner to link each issue under its pillar, or behind the Later gate with why", () => {
    const planner = brief("planner");
    expect(planner).toContain(
      "link every issue you open under the pillar it serves",
    );
    expect(planner).toContain(
      'link it behind the Later gate, the open issue whose title starts "Later gate:"',
    );
    expect(planner).toContain(
      "open its body with one sentence that says why it waits",
    );
    expect(brief("builder")).not.toContain("Later gate");
  });
});
