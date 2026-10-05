/**
 * `/asked`: what people asked of the crew, oldest unmet first, with one state
 * word each and a flag when nothing was built — the same rows on the page,
 * the API and the MCP, and only for repositories the viewer can write.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createAgent } from "../src/actions/crew.ts";
import { openIssue } from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { askedIn, askedRepos, STALE_DAYS } from "../src/core/asked.ts";
import type { Issue } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import { createRun } from "../src/core/runs.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const DAY = 24 * 60 * 60 * 1000;

describe("what you asked for", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;
  let repo: Repo;
  let aliceRo = "";
  let bobRo = "";
  const asks: Record<string, Issue> = {};
  let nextId = 1;
  let crewAt = "";

  const ask = (who: User, title: string): Issue => {
    const made = openIssue(app, who, repo, { title });
    if (!made.ok) throw new Error(String(made.error));
    return made.value;
  };

  /** A pull from `branch` whose description closes `issue`. */
  const pullFor = async (issue: Issue, branch: string) => {
    const committed = await commitToBranch(app, alice, repo, {
      branch,
      base: "main",
      message: branch,
      files: [{ path: `${branch.replace(/\//g, "-")}.md`, content: "x\n" }],
    });
    if (!committed.ok) throw new Error(String(committed.error));
    const opened = await openPull(app, alice, repo, {
      title: `Answers #${issue.number}`,
      body: `Closes #${issue.number}`,
      baseBranch: "main",
      headBranch: branch,
    });
    if (!opened.ok) throw new Error(String(opened.error));
    return opened.value;
  };

  const backdate = (issue: Issue, days: number) =>
    app.db
      .query("UPDATE issue SET created_at = ?1 WHERE id = ?2")
      .run(new Date(Date.now() - days * DAY).toISOString(), issue.id);

  const api = async (token: string | null, path: string) => {
    const res = await fetch(`${servers.url}${path}`, {
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
      redirect: "manual",
    });
    return {
      status: res.status,
      body: res.status === 200 ? ((await res.json()) as any) : null,
    };
  };

  const mcp = async (token: string, args: unknown) => {
    const res = await fetch(`${servers.url}/mcp`, {
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
        params: { name: "asked", arguments: args },
      }),
    });
    const body = (await res.json()) as any;
    const text: string = body.result.content[0].text;
    return body.result.isError === true
      ? { error: text }
      : { value: JSON.parse(text) };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-asked-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, {
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const b = await createUser(app.db, {
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!b.ok) throw new Error(b.error);
    bob = b.value;
    aliceRo = createToken(app.db, alice.id, "ro", "ro").token;
    bobRo = createToken(app.db, bob.id, "ro", "ro").token;
    const made = await createRepo(app, alice, {
      name: "garden",
      visibility: "public",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    await commitToBranch(app, alice, repo, {
      message: "seed",
      files: [{ path: "README.md", content: "# garden\n" }],
    });
    const bot = await createAgent(app, alice, { username: "bot" });
    if (!bot.ok) throw new Error(String(bot.error));

    asks["waiting"] = ask(alice, "Plant tomatoes");
    asks["stale"] = ask(alice, "Fix the gate");
    backdate(asks["stale"], STALE_DAYS + 1);
    asks["building"] = ask(alice, "A watering schedule");
    const building = await pullFor(asks["building"], "work/building");
    // The crew worked the pull an hour ago: that is the row's last activity.
    const run = createRun(app.db, { repoId: repo.id, kind: "agent", issueId: building.id });
    crewAt = new Date(Date.now() - 3_600_000).toISOString();
    app.db.query("UPDATE run SET created_at = ?1 WHERE id = ?2").run(crewAt, run.id);
    asks["shipped"] = ask(alice, "Prune the roses");
    const merged = await pullFor(asks["shipped"], "work/shipped");
    // A merge, as the row records it: the pull and the issue close.
    app.db
      .query("UPDATE pull SET merged_at = ?1 WHERE issue_id = ?2")
      .run(new Date().toISOString(), merged.id);
    app.db
      .query("UPDATE issue SET state = 'closed' WHERE id IN (?1, ?2)")
      .run(merged.id, asks["shipped"].id);
    asks["closed"] = ask(alice, "Paint the shed");
    app.db
      .query("UPDATE issue SET state = 'closed' WHERE id = ?1")
      .run(asks["closed"].id);
    // An agent's issue is not an ask.
    asks["agent"] = ask(
      getUserByName(app.db, "bot")!,
      "Refactor the watering module",
    );
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const states = () =>
    Object.fromEntries(
      askedIn(app.db, [repo], { show: "all" }).map((a) => [a.issue.title, a.state]),
    );

  test("each ask gets one state word from its pulls and its issue", () => {
    expect(states()).toEqual({
      "Plant tomatoes": "waiting",
      "Fix the gate": "waiting",
      "A watering schedule": "building",
      "Prune the roses": "shipped",
      "Paint the shed": "closed",
    });
  });

  test("an agent's issue is not an ask", () => {
    expect(states()["Refactor the watering module"]).toBeUndefined();
  });

  test("by default: nothing merged yet, oldest first; newest first on request", () => {
    const rows = askedIn(app.db, [repo]);
    expect(rows.map((a) => a.issue.title)).toEqual([
      "Fix the gate",
      "Plant tomatoes",
      "A watering schedule",
    ]);
    expect(
      askedIn(app.db, [repo], { order: "newest" }).map((a) => a.issue.title),
    ).toEqual(["A watering schedule", "Plant tomatoes", "Fix the gate"]);
  });

  test("an ask with nothing built past the window is flagged", () => {
    expect(
      askedIn(app.db, [repo], { show: "all" })
        .filter((a) => a.flagged)
        .map((a) => a.issue.title),
    ).toEqual(["Fix the gate"]);
    expect(
      askedIn(app.db, [repo], { show: "flagged" }).map((a) => a.issue.title),
    ).toEqual(["Fix the gate"]);
  });

  test("each row carries the crew's last activity, from the ask or its pulls", () => {
    const rows = new Map(askedIn(app.db, [repo]).map((a) => [a.issue.title, a]));
    expect(rows.get("A watering schedule")!.lastCrewAt).toBe(crewAt);
    expect(rows.get("Plant tomatoes")!.lastCrewAt).toBeNull();
  });

  test("a person who cannot write the repository reads nothing about it", () => {
    expect(askedRepos(app.db, bob, null)).toEqual([]);
    expect(askedRepos(app.db, bob, "alice/garden")).toEqual([]);
    expect(
      askedRepos(app.db, alice, "alice/garden").map((r) => r.name),
    ).toEqual(["garden"]);
  });

  test("the page lists the asks with their words; a signed-out reader is sent to sign in", async () => {
    const out = await fetch(`${servers.url}/asked`, { redirect: "manual" });
    expect(out.status).toBe(303);
    expect(out.headers.get("location")).toContain("/signin");

    const signin = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({
        username: "alice",
        password: "a-good-passphrase",
      }),
      redirect: "manual",
    });
    const cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
    const res = await fetch(`${servers.url}/asked`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const page = (await res.text()).replace(/\s+/g, " ");
    expect(page).toContain("What you asked for");
    expect(page).toContain("Plant tomatoes");
    expect(page).toContain("nothing built in 3 days");
    expect(page).not.toContain("Refactor the watering module");
    // The default view is what has nothing merged yet: the shipped ask waits behind "All".
    expect(page).not.toContain("Prune the roses");
    expect(page).toContain("crew not on it yet");
    expect(page.indexOf("Fix the gate")).toBeLessThan(page.indexOf("Plant tomatoes"));
    // Reached from the board and the feed's header, not only the asks page.
    expect(await (await fetch(`${servers.url}/board`, { headers: { cookie } })).text()).toContain('href="/asked"');
    expect(await (await fetch(`${servers.url}/`, { headers: { cookie } })).text()).toContain('href="/asked"');
    const flagged = (
      await (
        await fetch(`${servers.url}/asked?show=flagged`, {
          headers: { cookie },
        })
      ).text()
    ).replace(/\s+/g, " ");
    expect(flagged).toContain("Fix the gate");
    expect(flagged).not.toContain("Plant tomatoes");
  });

  test("the API answers the same rows, only to a token, and nothing to a stranger", async () => {
    expect((await api(null, "/api/v1/asked")).status).toBe(401);
    const mine = await api(aliceRo, "/api/v1/asked");
    expect(mine.status).toBe(200);
    expect(mine.body.asked.map((a: any) => a.title).sort()).toEqual([
      "A watering schedule",
      "Fix the gate",
      "Plant tomatoes",
    ]);
    const building = mine.body.asked.find(
      (a: any) => a.title === "A watering schedule",
    );
    expect(building.pulls[0].state).toBe("open");
    expect((await api(bobRo, "/api/v1/asked")).body.asked).toEqual([]);
    expect((await api(aliceRo, "/api/v1/asked?show=nope")).status).toBe(422);
    expect((await api(aliceRo, "/api/v1/asked?order=nope")).status).toBe(422);
    expect(building.lastCrewAt).toBe(crewAt);
    expect(Object.keys(building.pulls[0]).sort()).toEqual(["number", "state", "title"]);
  });

  test("the MCP `asked` tool reads the same rows, with an ro token", async () => {
    const all = await mcp(aliceRo, { repo: "alice/garden", show: "flagged" });
    expect(all.value.asked.map((a: any) => a.title)).toEqual(["Fix the gate"]);
    expect((await mcp(bobRo, { repo: "alice/garden" })).error).toContain(
      "not_found",
    );
    expect((await mcp(bobRo, {})).value.asked).toEqual([]);
  });
});
