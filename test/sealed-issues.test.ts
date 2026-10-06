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
import { commitToBranch, createRepo, forkRepo } from "../src/actions/repos.ts";
import type { Agent } from "../src/core/agents.ts";
import { recordDecision } from "../src/core/decisions.ts";
import { audienceFilter } from "../src/core/event_audience.ts";
import { listEvents } from "../src/core/events.ts";
import { getIssue, type Issue } from "../src/core/issues.ts";
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
  "/api/v1/search?q=X9QTITLE",
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
  "/search?q=X9QTITLE",
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

  // The crew's fix: a pull that closes the report is sealed with it.
  const fork = ok(await forkRepo(app, bot.user, repo, "square"));
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
