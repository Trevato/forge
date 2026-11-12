/** The one path (#7703): four words, each pull at one of them with a sentence, /pipeline explaining them, and the MCP answering the same. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createApp as createAppRecord } from "../src/core/apps.ts";
import { getPull } from "../src/core/pulls.ts";
import { getRepoById } from "../src/core/repos.ts";
import { pathStep, stepOfPull, STEPS } from "../src/flow/path.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { askForReviews } from "./helpers/reviews.ts";

quietLogs();

describe("pathStep", () => {
  const reviewer = { who: "reviewer", why: "no review yet" } as const;
  test("the four words, in order", () => {
    expect([...STEPS]).toEqual(["check", "review", "land", "live"]);
  });
  test("a running check is the check step, and says so even though nobody has reviewed", () => {
    expect(pathStep({ state: "open", check: "running", approvals: 0, next: reviewer })).toEqual({
      step: "check",
      why: "Its check is running.",
      done: false,
    });
  });
  test("a red check keeps the builder's reason", () => {
    const s = pathStep({ state: "open", check: "failed", approvals: 0, next: { who: "builder", why: "its check is red" } });
    expect(s?.step).toBe("check");
    expect(s?.why).toBe("Its check is red.");
  });
  test("green and unreviewed is review; no check recorded is not a check to wait for", () => {
    expect(pathStep({ state: "open", check: "ok", approvals: 0, next: reviewer })?.step).toBe("review");
    expect(pathStep({ state: "open", check: "none", approvals: 0, next: reviewer })).toEqual({
      step: "review",
      why: "No review yet.",
      done: false,
    });
  });
  test("approved and green is land, with the queue's reason", () => {
    const s = pathStep({ state: "open", check: "ok", approvals: 1, next: { who: "queue", why: "approved and green" } });
    expect(s).toEqual({ step: "land", why: "Approved and green.", done: false });
  });
  test("merged: live once production deployed, waiting for a release before, done where nothing deploys", () => {
    const merged = { state: "merged", check: "ok", approvals: 0, next: null } as const;
    expect(pathStep({ ...merged, deploys: true, liveSince: true })).toEqual({ step: "live", why: "Landed and live in production.", done: true });
    expect(pathStep({ ...merged, deploys: true, liveSince: false })?.done).toBe(false);
    expect(pathStep({ ...merged, deploys: false })).toMatchObject({ step: "land", done: true });
  });
  test("a pull closed without landing has no step", () => {
    expect(pathStep({ state: "closed", check: "ok", approvals: 0, next: null })).toBeNull();
  });
});

let dataDir: string;
let app: App;
let servers: Servers;
let alice: User;
let token = "";
const numbers: Record<string, number> = {};
const cells = process.env["FORGE_CELLS"];

const read = async (path: string): Promise<string> =>
  (await fetch(`${servers.url}${path}`, {
    headers: { cookie: `forge_session=${createSession(app.db, alice.id).token}` },
  })).text();

beforeAll(async () => {
  process.env["FORGE_CELLS"] = "off";
  dataDir = await mkdtemp(join(tmpdir(), "forge-path-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error(String(made.error));
  alice = made.value;
  token = createToken(app.db, alice.id, "rw", "rw").token;
  for (const name of ["open", "merged"]) {
    const repo = await createRepo(app, alice, { name, visibility: "public" });
    if (!repo.ok) throw new Error(String(repo.error));
    askForReviews(app.db, repo.value.id);
    for (const [branch, file] of [[undefined, "forge.json"], ["topic", "t.txt"]] as const) {
      const done = await commitToBranch(app, alice, repo.value, {
        ...(branch === undefined ? {} : { branch }),
        message: "change",
        files: [{ path: file, content: file === "forge.json" ? "{}" : "x" }],
      });
      if (!done.ok) throw new Error(JSON.stringify(done.error));
    }
    const pull = await openPull(app, alice, repo.value, { title: name, body: "", baseBranch: "main", headBranch: "topic" });
    if (!pull.ok) throw new Error(JSON.stringify(pull.error));
    numbers[name] = pull.value.number;
    if (name === "merged") {
      const done = await mergePull(app, alice, repo.value, pull.value, "merge");
      if (!done.ok) throw new Error(JSON.stringify(done.error));
    }
  }
});

afterAll(async () => {
  await servers.stop();
  app.close();
  if (cells === undefined) delete process.env["FORGE_CELLS"];
  else process.env["FORGE_CELLS"] = cells;
  await rm(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test("/pipeline names the four steps in order, each with its finer parts one click down", async () => {
  const res = await fetch(`${servers.url}/pipeline`);
  expect(res.status).toBe(200);
  const body = await res.text();
  const at = STEPS.map((s) => body.indexOf(`data-step="${s}"`));
  expect(at.every((i) => i > 0)).toBe(true);
  expect([...at].sort((a, b) => a - b)).toEqual(at);
  expect(body.match(/<details id="inside-/g)?.length).toBe(4);
  expect(body).toContain('href="/boards"');
});

test("an open pull says it is at review and why, on both tabs, linked to /pipeline", async () => {
  for (const tab of ["", "/files"]) {
    const body = await read(`/alice/open/pulls/${numbers["open"]}${tab}`);
    expect(body).toContain('data-path="review"');
    expect(body).toMatch(/<strong aria-current="step"[^>]*>Review<\/strong>/);
    expect(body).toContain("— No review yet.");
    expect(body).toContain('<a href="/pipeline">');
  }
});

test("a merged pull in a repository with no app says its path ends at land", async () => {
  const body = await read(`/alice/merged/pulls/${numbers["merged"]}`);
  expect(body).toContain('data-path="land"');
  expect(body).toContain("nothing deploys from this branch");
});

test("the MCP pull answers the same step", async () => {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "pull", arguments: { repo: "alice/open", number: numbers["open"] } },
    }),
  });
  const out: any = await res.json();
  expect(out.result.isError).not.toBe(true);
  const pull = JSON.parse(out.result.content[0].text) as { step: { step: string; why: string; done: boolean } };
  expect(pull.step).toEqual({ step: "review", why: "No review yet.", done: false });
});

test("a merged pull into an app is landed until production has served a deploy since the merge, then live", async () => {
  const made = await createRepo(app, alice, { name: "shipped", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  for (const [branch, file] of [[undefined, "forge.json"], ["topic", "t.txt"]] as const) {
    const done = await commitToBranch(app, alice, made.value, {
      ...(branch === undefined ? {} : { branch }),
      message: "change",
      files: [{ path: file, content: file === "forge.json" ? "{}" : "x" }],
    });
    if (!done.ok) throw new Error(JSON.stringify(done.error));
  }
  const opened = await openPull(app, alice, made.value, { title: "ship", body: "", baseBranch: "main", headBranch: "topic" });
  if (!opened.ok) throw new Error(JSON.stringify(opened.error));
  const merged = await mergePull(app, alice, made.value, opened.value, "merge");
  if (!merged.ok) throw new Error(JSON.stringify(merged.error));
  const record = createAppRecord(app.db, { repoId: made.value.id, slug: "shipped", access: "public" });
  if (!record.ok) throw new Error(record.error);

  const pull = getPull(app.db, made.value.id, opened.value.number)!;
  const repo = getRepoById(app.db, made.value.id)!;
  const live = { headOid: pull.headOid, conflicts: 0 };
  const deploy = (id: string, at: string, serving: string | null, env = "production") =>
    app.db
      .query("INSERT INTO run (id, repo_id, kind, env, state, created_at, serving_at) VALUES (?, ?, 'deploy', ?, 'ok', ?, ?)")
      .run(id, made.value.id, env, at, serving);

  // No deploy yet: landed, waiting for a release.
  expect(stepOfPull(app.db, repo, pull, live)).toEqual({
    step: "live",
    why: "Landed; it goes live with the next production release.",
    done: false,
  });
  // A production deploy that predates the merge, one still not serving, and a preview do not count.
  deploy("d-before", "2000-01-01T00:00:00.000Z", "2000-01-01T00:01:00.000Z");
  deploy("d-booting", "2999-01-01T00:00:00.000Z", null);
  deploy("d-preview", "2999-01-01T00:00:00.000Z", "2999-01-01T00:01:00.000Z", "pull-1");
  expect(stepOfPull(app.db, repo, pull, live)?.done).toBe(false);
  // One serving after the merge makes it live.
  deploy("d-after", "2999-01-01T00:00:00.000Z", "2999-01-01T00:01:00.000Z");
  expect(stepOfPull(app.db, repo, pull, live)).toEqual({ step: "live", why: "Landed and live in production.", done: true });
  expect(await read(`/alice/shipped/pulls/${opened.value.number}`)).toContain('data-path="live"');
});

test("/pipeline links the full-suite report's issues, and that link answers", async () => {
  process.env["FORGE_SENTINEL_REPO"] = "alice/open";
  try {
    const body = await (await fetch(`${servers.url}/pipeline`)).text();
    expect(body).toContain('id="full-suite"');
    expect(body).toContain('href="/alice/open/issues?label=full-suite"');
    expect((await fetch(`${servers.url}/alice/open/issues?label=full-suite`)).status).toBe(200);
  } finally {
    delete process.env["FORGE_SENTINEL_REPO"];
  }
});
