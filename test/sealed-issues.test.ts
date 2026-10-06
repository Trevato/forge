/**
 * A security report stays sealed on a public repository until it is fixed
 * (#621). A sealed issue — and the pull that closes it, and the runs and
 * decisions about it — is seen only by people who can write the repository
 * and by its crew. A stranger and a signed-in reader see nothing of it: not
 * in a list, a page, search, the map, events, the feed, MCP or the API. It
 * opens to everyone only when a writer unseals it, which is recorded.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { addComment } from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo, sealedForkFor } from "../src/actions/repos.ts";
import type { Agent } from "../src/core/agents.ts";
import { recordDecision } from "../src/core/decisions.ts";
import { audienceFilter } from "../src/core/event_audience.ts";
import { listEvents } from "../src/core/events.ts";
import { getIssue, issueCounts, type Issue } from "../src/core/issues.ts";
import { branchFor } from "../src/crew/brief.ts";
import { readyState } from "../src/crew/autonomy.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { claimRun, createRun } from "../src/core/runs.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { localSource } from "../src/view/local.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

/** Words that exist only inside the sealed report: any surface that shows one leaks. */
const TITLE = "Sealed X9QTITLE token bypass";
const BODY = "X9QBODY the check is missing on the path";
const COMMENT = "X9QCOMMENT confirmed on main";
const SECRETS = ["X9QTITLE", "X9QBODY", "X9QCOMMENT", "X9QPULL"];

let dataDir: string;
let app: App;
let servers: Servers;
let alice: User;
let mallory: User;
let bot: Agent;
let repo: Repo;
let report: Issue;
let fix: Issue;
let runId: string;
const token: Record<string, string> = {};

const ok = <T>(
  r: { ok: true; value: T } | { ok: false; error: unknown },
): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

async function get(
  path: string,
  who?: string,
): Promise<{ status: number; text: string }> {
  const res = await fetch(`${servers.url}${path}`, {
    headers: who === undefined ? {} : { authorization: `Bearer ${token[who]}` },
    redirect: "manual",
  });
  return { status: res.status, text: await res.text() };
}

async function mcp(who: string, name: string, args: unknown): Promise<string> {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token[who]}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  return JSON.stringify(await res.json());
}

const leaks = (text: string): string[] =>
  SECRETS.filter((s) => text.includes(s));

/** Every surface a person or an agent reads, by path, with a page or a list on it. */
const LISTS = (n: number, p: number) => [
  "/api/v1/repos/alice/square/issues?state=all",
  "/api/v1/repos/alice/square/pulls?state=all",
  "/api/v1/search?q=bypass",
  "/api/v1/repos/alice/square/events",
  "/api/v1/repos/alice/square/map",
  "/api/v1/repos/alice/square/decisions",
  "/api/v1/repos/alice/square/runs",
  "/api/v1/front",
  "/api/v1/here?repo=alice/square",
  "/alice/square/issues?state=all",
  "/alice/square/pulls?state=all",
  "/alice/square/map",
  "/alice/square/runs",
  "/alice/square/activity.atom",
  "/search?q=bypass",
  "/alice/square",
  `/alice/square/issues/${n - 1}`,
  `/alice/square/pulls/${p - 1}`,
];
const SINGLES = (n: number, p: number) => [
  `/api/v1/repos/alice/square/issues/${n}`,
  `/api/v1/repos/alice/square/issues/${n}/dependencies`,
  `/api/v1/repos/alice/square/pulls/${p}`,
  `/api/v1/repos/alice/square/pulls/${p}/review-states`,
  `/api/v1/repos/alice/square/runs/${runId}`,
  `/api/v1/repos/alice/square/runs/${runId}/log`,
  `/alice/square/issues/${n}`,
  `/alice/square/tells/${n}`,
  `/alice/square/pulls/${p}`,
  `/alice/square/changes/${p}`,
  `/alice/square/runs/${runId}`,
];

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-sealed-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  alice = ok(
    await createUser(app.db, {
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    }),
  );
  mallory = ok(
    await createUser(app.db, {
      trusted: true,
      username: "mallory",
      email: "mallory@forge.local",
      password: "a-good-passphrase",
    }),
  );
  bot = ok(await createAgent(app, alice, { username: "bot" }));
  repo = ok(
    await createRepo(app, alice, { name: "square", visibility: "public" }),
  );
  ok(
    await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "# square\n" }],
    }),
  );
  expect(addToCrew(app, alice, repo, "bot").ok).toBe(true);
  token.alice = createToken(app.db, alice.id, "t", "rw").token;
  token.mallory = createToken(app.db, mallory.id, "t", "rw").token;
  token.bot = createToken(app.db, bot.user.id, "t", "rw").token;

  // An ordinary issue and pull beside it, so lists are not empty.
  await fetch(`${servers.url}/api/v1/repos/alice/square/issues`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token.alice}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ title: "Rounder corners", body: "Public work." }),
  });
  // The report, sealed as it is opened.
  const opened = await fetch(
    `${servers.url}/api/v1/repos/alice/square/issues`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.alice}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: TITLE, body: BODY, sealed: true }),
    },
  );
  expect(opened.status).toBe(201);
  const n = ((await opened.json()) as { number: number }).number;
  report = getIssue(app.db, repo.id, n)!;
  ok(addComment(app, alice, repo, report, COMMENT));

  // The crew's fix: a pull that closes the report is sealed with it. It is
  // worked where the crew works sealed reports — its private repository; a
  // public fork's branch would publish the fix (#865).
  const fork = ok(await sealedForkFor(app, bot.user, repo));
  ok(
    await commitToBranch(app, bot.user, fork, {
      branch: `bot/${n}`,
      base: "main",
      message: "Fix",
      files: [{ path: "fix.ts", content: "export const fixed = true;\n" }],
    }),
  );
  const pull = ok(
    await openPull(app, bot.user, repo, {
      title: "X9QPULL check the path",
      body: `Closes #${n}`,
      baseBranch: "main",
      headBranch: `bot/${n}`,
      headRepo: fork,
    }),
  );
  fix = getIssue(app.db, repo.id, pull.number)!;
  // A run at work on it, and a decision about it.
  const run = createRun(app.db, {
    repoId: repo.id,
    kind: "agent",
    issueId: report.id,
    actorId: bot.user.id,
    reason: "assigned",
  });
  claimRun(app.db, run.id);
  runId = run.id;
  recordDecision(app.db, {
    kind: "next",
    repoId: repo.id,
    issueId: report.id,
    state: { title: TITLE },
    answer: String(n),
    p: 1,
    by: "rule",
    ms: 0,
  });
}, 60_000);

afterAll(async () => {
  servers?.stop();
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("a stranger and a reader see nothing of a sealed report", () => {
  for (const who of [undefined, "mallory"] as const)
    test(`${who ?? "a stranger"}: every list and page leaves it out, and every direct read is not found`, async () => {
      for (const path of LISTS(report.number, fix.number)) {
        const { text } = await get(path, who);
        expect({ path, leaks: leaks(text) }).toEqual({ path, leaks: [] });
      }
      for (const path of SINGLES(report.number, fix.number)) {
        const { status, text } = await get(path, who);
        expect({ path, status, leaks: leaks(text) }).toEqual({
          path,
          status: 404,
          leaks: [],
        });
      }
    });

  test("a reader's MCP: the map, what is happening now and speaking on it", async () => {
    expect(leaks(await mcp("mallory", "map", { app: "alice/square" }))).toEqual(
      [],
    );
    expect(leaks(await mcp("mallory", "now", {}))).toEqual([]);
    const said = await mcp("mallory", "say", {
      repo: "alice/square",
      number: report.number,
      text: "hello",
    });
    expect(said).toContain("not_found");
  });

  test("events: the stream a reader is sent leaves out what is about it", () => {
    const events = listEvents(app.db, { repoId: repo.id });
    const about = events.filter(
      (e) =>
        e.payload["number"] === report.number ||
        e.payload["number"] === fix.number ||
        e.payload["issueId"] === report.id,
    );
    expect(about.length).toBeGreaterThan(0);
    const reader = audienceFilter(app.db, mallory);
    const anyone = audienceFilter(app.db, undefined);
    expect(about.filter(reader)).toEqual([]);
    expect(about.filter(anyone)).toEqual([]);
    expect(about.filter(audienceFilter(app.db, alice)).length).toBe(
      about.length,
    );
  });

  test("the terminal's source finds nothing", async () => {
    const source = localSource(app, getRepoById(app.db, repo.id)!, mallory);
    const listed = await source.issues({ kind: "issue", state: "all" });
    expect(JSON.stringify(listed)).not.toContain("X9QTITLE");
    const one = await source.issue(report.number);
    expect(one.ok).toBe(false);
  });

  test("a reader cannot seal or unseal", async () => {
    const res = await fetch(
      `${servers.url}/api/v1/repos/alice/square/issues/${report.number}`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${token.mallory}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ sealed: false }),
      },
    );
    expect(res.status).toBe(404);
    expect(getIssue(app.db, repo.id, report.number)!.sealed).toBe(true);
  });
});

describe("a reader who files a sealed report follows it, and only it", () => {
  test("its author reads it, comments on it and finds it in lists and search; may not close it; a second stranger finds nothing", async () => {
    const eve = ok(
      await createUser(app.db, {
        trusted: true,
        username: "eve",
        email: "eve@forge.local",
        password: "a-good-passphrase",
      }),
    );
    token.eve = createToken(app.db, eve.id, "t", "rw").token;
    const filed = await fetch(`${servers.url}/api/v1/repos/alice/square/issues`, {
      method: "POST",
      headers: { authorization: `Bearer ${token.mallory}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "X9QMINE reset link reuse", body: "X9QMINEBODY", sealed: true }),
    });
    expect(filed.status).toBe(201);
    const mine = ((await filed.json()) as { number: number }).number;

    // The reporter: the issue, with its mark, in lists and in search.
    const one = await get(`/api/v1/repos/alice/square/issues/${mine}`, "mallory");
    expect(one.status).toBe(200);
    expect((JSON.parse(one.text) as { sealed: boolean }).sealed).toBe(true);
    expect((await get("/api/v1/repos/alice/square/issues?state=all", "mallory")).text).toContain("X9QMINE");
    expect((await get("/api/v1/search?q=reuse", "mallory")).text).toContain("X9QMINE");
    expect((await get(`/alice/square/issues/${mine}`, "mallory")).status).toBe(200);
    const said = await fetch(
      `${servers.url}/api/v1/repos/alice/square/issues/${mine}/comments`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token.mallory}`, "content-type": "application/json" },
        body: JSON.stringify({ body: "It also works on the API." }),
      },
    );
    expect(said.status).toBe(201);
    // Events about it reach its author.
    const about = listEvents(app.db, { repoId: repo.id }).filter(
      (e) => e.payload["number"] === mine,
    );
    expect(about.filter(audienceFilter(app.db, mallory)).length).toBe(about.length);
    // Its state is the writers'.
    const closed = await fetch(
      `${servers.url}/api/v1/repos/alice/square/issues/${mine}`,
      {
        method: "PATCH",
        headers: { authorization: `Bearer ${token.mallory}`, "content-type": "application/json" },
        body: JSON.stringify({ state: "closed" }),
      },
    );
    expect(closed.status).toBe(403);
    // Still nothing of anyone else's sealed report.
    expect((await get(`/api/v1/repos/alice/square/issues/${report.number}`, "mallory")).status).toBe(404);
    // A second stranger, and nobody signed in, find nothing of it.
    for (const who of ["eve", undefined] as const) {
      const { status, text } = await get(`/api/v1/repos/alice/square/issues/${mine}`, who);
      expect({ who, status }).toEqual({ who, status: 404 });
      expect(text).not.toContain("X9QMINE");
      expect((await get("/api/v1/repos/alice/square/issues?state=all", who)).text).not.toContain("X9QMINE");
      expect((await get("/api/v1/search?q=reuse", who)).text).not.toContain("X9QMINE");
    }
    expect(about.filter(audienceFilter(app.db, eve))).toEqual([]);
  });
});

describe("nothing about it leaves the forge", () => {
  test("a webhook is never queued an event about it; it is for one about public work", () => {
    app.db
      .query("INSERT INTO webhook (id, repo_id, url) VALUES ('hook1', ?1, 'https://hooks.example/x')")
      .run(repo.id);
    // The bus queues deliveries as an event is appended (`enqueueForEvent`).
    const queued = (number: number) => {
      const event = app.bus.append({
        kind: "issue.commented",
        repoId: repo.id,
        actorId: alice.id,
        payload: { number, body: "words" },
      });
      return app.db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM webhook_delivery WHERE event_id = ?1",
        )
        .get(event.id)!.n;
    };
    expect(queued(report.number)).toBe(0);
    expect(queued(fix.number)).toBe(0);
    expect(queued(1)).toBe(1);
  });

  test("its title is not in the crew's branch name, nor sent to a decider", () => {
    expect(branchFor(bot, report)).toBe(`bot/${report.number}`);
    const state = JSON.stringify(
      readyState(app.db, repo, [{ issue: report, holdsUp: 0, waitsFor: 0 }]),
    );
    expect(leaks(state)).toEqual([]);
  });

  test("it is not counted in the open count everyone sees", () => {
    expect(issueCounts(app.db, repo.id, "issue").open).toBe(1);
  });
});

describe("sealing from the page and the MCP", () => {
  test("a reader's seal is refused on both; a writer's lands, recorded", async () => {
    const open = await fetch(`${servers.url}/api/v1/repos/alice/square/issues`, {
      method: "POST",
      headers: { authorization: `Bearer ${token.alice}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "Found a hole late", body: "X9QLATE" }),
    });
    const late = ((await open.json()) as { number: number }).number;
    const tried = await mcp("mallory", "seal", {
      repo: "alice/square",
      number: late,
      sealed: true,
    });
    expect(tried).toContain("isError");
    const page = await fetch(`${servers.url}/alice/square/issues/${late}/seal`, {
      method: "POST",
      headers: { authorization: `Bearer ${token.mallory}` },
      body: new URLSearchParams({ sealed: "1" }),
      redirect: "manual",
    });
    expect(page.status).toBe(303);
    expect(getIssue(app.db, repo.id, late)!.sealed).toBe(false);
    const sealed = await mcp("alice", "seal", {
      repo: "alice/square",
      number: late,
      sealed: true,
    });
    expect(sealed).toContain("is sealed");
    expect(getIssue(app.db, repo.id, late)!.sealed).toBe(true);
    expect((await get(`/alice/square/issues/${late}`, "mallory")).status).toBe(404);
    // The page unseals it.
    const unsealed = await fetch(`${servers.url}/alice/square/issues/${late}/seal`, {
      method: "POST",
      headers: { authorization: `Bearer ${token.alice}` },
      body: new URLSearchParams({ sealed: "0" }),
      redirect: "manual",
    });
    expect(unsealed.status).toBe(303);
    expect(getIssue(app.db, repo.id, late)!.sealed).toBe(false);
    expect(
      listEvents(app.db, { repoId: repo.id }).filter(
        (e) => e.payload["number"] === late && e.kind.endsWith("sealed"),
      ).map((e) => e.kind),
    ).toEqual(["issue.unsealed", "issue.sealed"]);
  });
});

describe("a writer and the crew see it", () => {
  for (const who of ["alice", "bot"] as const)
    test(`${who} reads it, its pull and its run`, async () => {
      for (const path of [
        `/api/v1/repos/alice/square/issues/${report.number}`,
        `/api/v1/repos/alice/square/pulls/${fix.number}`,
        `/api/v1/repos/alice/square/runs/${runId}`,
      ]) {
        const { status } = await get(path, who);
        expect({ path, status }).toEqual({ path, status: 200 });
      }
      const { text } = await get(
        "/api/v1/repos/alice/square/issues?state=all",
        who,
      );
      expect(text).toContain("X9QTITLE");
    });
});

describe("unsealing", () => {
  test("a writer unseals it, it is recorded, and then everyone sees it", async () => {
    const res = await fetch(
      `${servers.url}/api/v1/repos/alice/square/issues/${report.number}`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${token.alice}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ sealed: false }),
      },
    );
    expect(res.status).toBe(200);
    expect(
      listEvents(app.db, { repoId: repo.id }).some(
        (e) =>
          e.kind === "issue.unsealed" && e.payload["number"] === report.number,
      ),
    ).toBe(true);
    const { status, text } = await get(
      `/api/v1/repos/alice/square/issues/${report.number}`,
      "mallory",
    );
    expect(status).toBe(200);
    expect(text).toContain("X9QTITLE");
  });
});
