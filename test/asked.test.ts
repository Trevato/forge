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
import {
  ASKED_LIMIT,
  askedCounts,
  askedIn,
  askedRepos,
  STALE_DAYS,
} from "../src/core/asked.ts";
import { addComment, createIssue, type Issue } from "../src/core/issues.ts";
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
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const b = await createUser(app.db, { origin: "seed", trusted: true,
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

  test("the counts, made in SQL, agree with the list kind by kind", () => {
    const all = askedIn(app.db, [repo], { show: "all", limit: ASKED_LIMIT });
    expect(askedCounts(app.db, [repo])).toEqual({
      asked: all.length,
      shipped: all.filter((a) => a.state === "shipped").length,
      unshipped: all.filter((a) => a.state === "waiting" || a.state === "building").length,
      flagged: all.filter((a) => a.flagged).length,
    });
    expect(askedCounts(app.db, [])).toEqual({ asked: 0, shipped: 0, unshipped: 0, flagged: 0 });
    // The fixture holds every state, so the agreement is not a run of zeros.
    expect(new Set(all.map((a) => a.state))).toEqual(
      new Set(["waiting", "building", "shipped", "closed"]),
    );
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
    // The filter bar is §5's bar: the retired .filters is gone, the words stay.
    expect(page).not.toMatch(/class="[^"]*\bfilters\b/);
    expect(page).toContain("Not shipped");
    expect(page).toContain("Nothing built");
    expect(page).toContain("Show newest first");
    expect(page).not.toContain("Refactor the watering module");
    // The default view is what has nothing merged yet: the shipped ask waits behind "All".
    expect(page).not.toContain("Prune the roses");
    expect(page).toContain("not placed yet");
    expect(page.indexOf("Fix the gate")).toBeLessThan(page.indexOf("Plant tomatoes"));
    // Reached from the board and the feed's header, not only the asks page.
    expect(await (await fetch(`${servers.url}/board`, { headers: { cookie } })).text()).toContain('href="/asked"');
    expect(await (await fetch(`${servers.url}/feed`, { headers: { cookie } })).text()).toContain('href="/asked"');
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
    expect(Object.keys(building.pulls[0]).sort()).toEqual([
      "number",
      "openedAt",
      "state",
      "title",
    ]);
  });

  test("the MCP `asked` tool reads the same rows, with an ro token", async () => {
    const all = await mcp(aliceRo, { repo: "alice/garden", show: "flagged" });
    expect(all.value.asked.map((a: any) => a.title)).toEqual(["Fix the gate"]);
    expect((await mcp(bobRo, { repo: "alice/garden" })).error).toContain(
      "not_found",
    );
    expect((await mcp(bobRo, {})).value.asked).toEqual([]);
  });

  test("the page leads each row with what became of it, so a narrow screen cuts where and who, not that", async () => {
    const signin = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({
        username: "alice",
        password: "a-good-passphrase",
      }),
      redirect: "manual",
    });
    const cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
    const page = await (
      await fetch(`${servers.url}/asked`, { headers: { cookie } })
    ).text();
    const meta = (title: string) =>
      (
        page.match(
          new RegExp(
            `${title}</a></span\\s*>\\s*<span class="row-meta">([\\s\\S]*?)</span>`,
          ),
        )?.[1] ?? ""
      )
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim();
    expect(meta("Plant tomatoes")).toStartWith(
      "not placed yet · alice/garden #",
    );
    expect(meta("A watering schedule")).toMatch(
      /^aliceowner building in #\d+ · alice\/garden #\d+$/,
    );
  });

  // Last, because it moves the crew's last activity the tests above read.
  test("an agent's comment is the crew's last activity too; a person's comment is not", () => {
    const bot = getUserByName(app.db, "bot")!;
    const at = (minutesAgo: number) =>
      new Date(Date.now() - minutesAgo * 60_000).toISOString();
    const say = (who: User, issueId: string, when: string) => {
      const said = addComment(app.db, {
        issueId,
        authorId: who.id,
        body: "A word on this.",
      });
      if (!said.ok) throw new Error(said.error);
      app.db
        .query("UPDATE comment SET created_at = ?1 WHERE id = ?2")
        .run(when, said.value.id);
    };
    const lastOf = (title: string) =>
      askedIn(app.db, [repo]).find((a) => a.issue.title === title)!;

    // Nothing ran on this ask: the agent's comment alone is the activity,
    // and the person's later one does not move it.
    const botAt = at(120);
    say(bot, asks["waiting"]!.id, botAt);
    say(alice, asks["waiting"]!.id, at(5));
    expect(lastOf("Plant tomatoes").lastCrewAt).toBe(botAt);

    // On a pull that closes the ask, newer than the run: the comment wins.
    const building = lastOf("A watering schedule");
    const onPull = at(10);
    say(bot, building.pulls[0]!.id, onPull);
    expect(lastOf("A watering schedule").lastCrewAt).toBe(onPull);
    // And an older comment does not move it back.
    say(bot, building.issue.id, at(600));
    expect(lastOf("A watering schedule").lastCrewAt).toBe(onPull);
  });
});

describe("an old ask says what exists for it", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let alice: User;
  let repo: Repo;
  let ro = "";

  const old = (title: string, days: number): Issue => {
    const made = openIssue(app, alice, repo, { title });
    if (!made.ok) throw new Error(String(made.error));
    app.db
      .query("UPDATE issue SET created_at = ?1 WHERE id = ?2")
      .run(new Date(Date.now() - days * DAY).toISOString(), made.value.id);
    return made.value;
  };
  /** A pull that closes `issue`, opened `days` ago. */
  const pullFor = async (issue: Issue, branch: string, days: number) => {
    const committed = await commitToBranch(app, alice, repo, {
      branch,
      base: "main",
      message: branch,
      files: [{ path: `${branch}.md`, content: "x\n" }],
    });
    if (!committed.ok) throw new Error(String(committed.error));
    const opened = await openPull(app, alice, repo, {
      title: `Answers #${issue.number}`,
      body: `Closes #${issue.number}`,
      baseBranch: "main",
      headBranch: branch,
    });
    if (!opened.ok) throw new Error(String(opened.error));
    app.db
      .query("UPDATE issue SET created_at = ?1 WHERE id = ?2")
      .run(new Date(Date.now() - days * DAY).toISOString(), opened.value.id);
    return opened.value;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-asked-old-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    ro = createToken(app.db, alice.id, "ro", "ro").token;
    const made = await createRepo(app, alice, {
      name: "garden",
      visibility: "private",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    await commitToBranch(app, alice, repo, {
      message: "seed",
      files: [{ path: "README.md", content: "# garden\n" }],
    });
    // All four were asked five days ago, past the three-day window.
    old("Nothing at all", 5);
    await pullFor(old("A pull is open", 5), "open", 2);
    const dropped = await pullFor(old("Its only pull closed", 5), "dropped", 4);
    app.db
      .query("UPDATE issue SET state = 'closed' WHERE id = ?1")
      .run(dropped.id);
    const onIt = old("The crew is on it", 5);
    createRun(app.db, { repoId: repo.id, kind: "agent", issueId: onIt.id });
    // And one asked today, with a pull opened today.
    await pullFor(old("Asked today", 0), "today", 0);
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const rows = () =>
    new Map(
      askedIn(app.db, [repo], { show: "all" }).map((a) => [a.issue.title, a]),
    );

  test("nothing built is for an old ask with no pull open or merged and nobody on it", () => {
    const all = rows();
    const facts = (title: string) => {
      const a = all.get(title)!;
      return [a.state, a.stale, a.flagged];
    };
    expect(facts("Nothing at all")).toEqual(["waiting", true, true]);
    expect(facts("Its only pull closed")).toEqual(["waiting", true, true]);
    expect(facts("A pull is open")).toEqual(["building", true, false]);
    expect(facts("The crew is on it")).toEqual(["building", true, false]);
    expect(facts("Asked today")).toEqual(["building", false, false]);
    expect(
      askedIn(app.db, [repo], { show: "flagged" }).map((a) => a.issue.title),
    ).toEqual(["Nothing at all", "Its only pull closed"]);
    expect(askedCounts(app.db, [repo])).toEqual({
      asked: 5,
      shipped: 0,
      unshipped: 5,
      flagged: 2,
    });
  });

  test("the page says a pull is open and for how long; red only where nothing exists", async () => {
    const signin = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({
        username: "alice",
        password: "a-good-passphrase",
      }),
      redirect: "manual",
    });
    const cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
    const page = await (
      await fetch(`${servers.url}/asked`, { headers: { cookie } })
    ).text();
    /** The badge of the row with this title: its tone and its words. */
    const badgeOf = (title: string): string => {
      const row =
        page.match(
          new RegExp(
            `${title}</a></span[\\s\\S]*?<span class="row-trail">([\\s\\S]*?)</li>`,
          ),
        )?.[1] ?? "";
      const tone = row.match(/data-variant="(\w+)"/)?.[1] ?? "default";
      return `${tone}: ${row
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim()}`;
    };
    expect(badgeOf("Nothing at all")).toBe("danger: Nothing built");
    expect(badgeOf("Its only pull closed")).toBe("danger: Nothing built");
    expect(badgeOf("A pull is open")).toBe("attn: Building");
    expect(badgeOf("The crew is on it")).toBe("attn: Building");
    expect(badgeOf("Asked today")).toBe("attn: Building");
    expect(page).toContain("5 asked · 0 landed · 2 with nothing built");
  });

  test("the API and the MCP say stale and flagged apart, and when each pull was opened", async () => {
    const res = await fetch(`${servers.url}/api/v1/asked?show=all`, {
      headers: { authorization: `Bearer ${ro}` },
    });
    const asked = ((await res.json()) as any).asked as any[];
    const open = asked.find((a) => a.title === "A pull is open");
    expect([open.stale, open.flagged]).toEqual([true, false]);
    expect(Date.now() - Date.parse(open.pulls[0].openedAt)).toBeGreaterThan(
      2 * DAY - 60_000,
    );
    const none = asked.find((a) => a.title === "Nothing at all");
    expect([none.stale, none.flagged]).toEqual([true, true]);
    const mcp = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${ro}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "asked", arguments: { show: "flagged" } },
      }),
    });
    const told = JSON.parse(((await mcp.json()) as any).result.content[0].text)
      .asked as any[];
    expect(told.map((a) => a.title)).toEqual([
      "Nothing at all",
      "Its only pull closed",
    ]);
  });
});

describe("a repository with more asks than one read", () => {
  /** More than the 2,000 the scan once stopped at. */
  const MANY = 2_100;
  let dataDir = "";
  let app: App;
  let repo: Repo;
  let alice: User;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-asked-many-"));
    app = createApp({ dataDir, port: 0 });
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const made = await createRepo(app, alice, {
      name: "orchard",
      visibility: "private",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    // One ask from long ago that nothing was built for, then many since.
    app.db.exec("BEGIN");
    for (let i = 0; i <= MANY; i++) {
      const opened = createIssue(app.db, {
        repoId: repo.id,
        authorId: alice.id,
        title: i === 0 ? "The oldest wish" : `Ask ${i}`,
      });
      if (!opened.ok) throw new Error(opened.error);
    }
    app.db.exec("COMMIT");
    // Asked a minute apart, oldest first, the first one a month ago.
    app.db
      .query(
        `UPDATE issue SET created_at =
           strftime('%Y-%m-%dT%H:%M:%fZ', '2026-01-01T00:00:00Z', '+' || number || ' minutes')
         WHERE repo_id = ?1`,
      )
      .run(repo.id);
  }, 60_000);

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const now = new Date("2026-02-01T00:00:00Z");

  test("the oldest unmet ask is first, however many came after", () => {
    const rows = askedIn(app.db, [repo], { now });
    expect(rows).toHaveLength(ASKED_LIMIT);
    expect(rows[0]!.issue.title).toBe("The oldest wish");
    expect(rows[1]!.issue.title).toBe("Ask 1");
    expect(rows.every((a) => a.flagged)).toBe(true);
    const newest = askedIn(app.db, [repo], { now, order: "newest" });
    expect(newest[0]!.issue.title).toBe(`Ask ${MANY}`);
    expect(newest.at(-1)!.issue.title).toBe(`Ask ${MANY - ASKED_LIMIT + 1}`);
  });

  test("the counts are of every ask, not of one page", () => {
    expect(askedCounts(app.db, [repo], now)).toEqual({
      asked: MANY + 1,
      shipped: 0,
      unshipped: MANY + 1,
      flagged: MANY + 1,
    });
  });

  test("asks that are closed are read past: the page still fills with what is unmet, oldest first", () => {
    // Everything but the oldest wish and the newest fifty is closed.
    app.db
      .query(
        "UPDATE issue SET state = 'closed' WHERE repo_id = ?1 AND number > 1 AND number <= ?2",
      )
      .run(repo.id, MANY + 1 - 50);
    const rows = askedIn(app.db, [repo], { now });
    expect(rows.map((a) => a.issue.title)).toEqual([
      "The oldest wish",
      ...Array.from({ length: 50 }, (_, i) => `Ask ${MANY - 49 + i}`),
    ]);
    expect(askedCounts(app.db, [repo], now)).toEqual({
      asked: MANY + 1,
      shipped: 0,
      unshipped: 51,
      flagged: 51,
    });
    expect(askedIn(app.db, [repo], { now, show: "all" })).toHaveLength(
      ASKED_LIMIT,
    );
  });
});
