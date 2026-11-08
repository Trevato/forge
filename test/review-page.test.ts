/** `/review` lists each ask waiting on a person as one row with its why. */
import { seatAs } from "./helpers/seat.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addComment, openIssue } from "../src/actions/issues.ts";
import { addComment as addRawComment } from "../src/core/issues.ts";
import { addCrew, createAgentRow } from "../src/core/agents.ts";
import { recordLook } from "../src/core/looks.ts";
import { previewEnv } from "../src/apps/data.ts";
import { createApp as createAppRow } from "../src/core/apps.ts";
import { createRepo as createRepoRow } from "../src/core/repos.ts";
import { submitReview } from "../src/core/reviews.ts";
import { createUser } from "../src/core/users.ts";
import { BREAKER_NOTE } from "../src/crew/breaker.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { id } from "../src/kernel/id.ts";
import { rememberStat, settled } from "../src/web/studio/review_evidence.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const ZERO = "0".repeat(40);
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

let root = "";
let app: App;
let servers: Servers;
let cookie = "";
let bobCookie = "";

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-review-"));
  app = createApp({ dataDir: root, port: 0 });
  servers = await serve(app);
  const mk = async (username: string, agent: boolean) => {
    const made = await createUser(app.db, {
      username,
      email: `${username}@forge.test`,
      ...(agent
        ? { agent: true, origin: "agent" as const }
        : { password: "a-good-passphrase", origin: "seed" as const, trusted: true, adminIfFirst: true }),
    });
    if (!made.ok) throw new Error(made.error);
    if (agent) createAgentRow(app.db, { userId: made.value.id, brief: `${username}.` });
    return made.value;
  };
  const alice = await mk("alice", false);
  const builder = await mk("builder", true);
  const reviewer = await mk("reviewer", true);
  const made = await createRepoRow(app.db, app.reposRoot, {
    ownerId: alice.id,
    name: "wait",
    visibility: "public",
    description: "wait",
  });
  if (!made.ok) throw new Error(made.error);
  const repo = made.value;
  for (const a of [builder, reviewer]) addCrew(app.db, repo.id, a.id, alice.id);
  seatAs(app.db, repo.id, reviewer.id, "reviewer");
  let seq = 0;
  const pull = (author: string, title: string, age: number) => {
    const issueId = id();
    const number = app.db
      .query<{ issue_seq: number }, [string]>("UPDATE repo SET issue_seq = issue_seq + 1 WHERE id = ?1 RETURNING issue_seq")
      .get(repo.id)!.issue_seq;
    app.db
      .query(
        `INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at)
         VALUES (?1, ?2, ?3, 'pull', ?4, '', ?5, 'open', ?6)`,
      )
      .run(issueId, repo.id, number, title, author, hoursAgo(age));
    app.db
      .query(
        `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id)
         VALUES (?1, 'main', ?2, ?3, ?3, ?4)`,
      )
      .run(issueId, `b/${++seq}`, ZERO, repo.id);
    return issueId;
  };
  const handed = pull(builder.id, "Handed over pull", 3);
  for (let r = 0; r < 3; r++)
    submitReview(app.db, { issueId: handed, authorId: reviewer.id, state: "changes_requested", body: `Round ${r}.`, commitOid: ZERO });
  const stale = pull(alice.id, "Stale pull", 30);
  addRawComment(app.db, { issueId: stale, authorId: reviewer.id, body: "Recommendation: change — rename the <flag>." });
  app.db
    .query(`INSERT INTO run (id, repo_id, kind, issue_id, commit_oid, state) VALUES (?1, ?2, 'check', ?3, ?4, 'running')`)
    .run(id(), repo.id, handed, ZERO);
  for (const state of ["ok", "failed", "cancelled"]) {
    const fresh = pull(alice.id, `Fresh ${state} pull`, 30);
    app.db
      .query(`INSERT INTO run (id, repo_id, kind, issue_id, commit_oid, state) VALUES (?1, ?2, 'check', ?3, ?4, ?5)`)
      .run(id(), repo.id, fresh, ZERO, state);
  }
  const older = stale;
  app.db
    .query(`INSERT INTO run (id, repo_id, kind, issue_id, commit_oid, state) VALUES (?1, ?2, 'check', ?3, ?4, 'running')`)
    .run(id(), repo.id, older, "1".repeat(40));
  const made2 = createAppRow(app.db, { repoId: repo.id, slug: "wait", access: "public" });
  if (!made2.ok) throw new Error(String(made2.error));
  const record = made2.value;
  const numberOf = (issueId: string) =>
    app.db.query<{ number: number }, [string]>("SELECT number FROM issue WHERE id = ?1").get(issueId)!.number;
  const shot = (issueId: string, commitOid: string, takenAs: "owner" | "nobody") =>
    recordLook(app.db, { appId: record.id, env: previewEnv(numberOf(issueId)), commitOid, kind: "thumb", path: "looks/x.png", takenAs });
  shot(stale, ZERO, "nobody");
  recordLook(app.db, { appId: record.id, env: "production", commitOid: "1".repeat(40), kind: "thumb", path: "looks/m.png", takenAs: "nobody" });
  const bob = await mk("bob", false);
  const mine = pull(builder.id, "Assigned to bob", 2);
  app.db.query("UPDATE issue SET assignee_id = ?2 WHERE id = ?1").run(mine, bob.id);
  shot(mine, ZERO, "owner");
  pull(builder.id, "Young crew pull", 2);
  const issue = openIssue(app, alice, repo, { title: "Crew asked about this" });
  if (!issue.ok) throw new Error(String(issue.error));
  addComment(app, alice, repo, issue.value, BREAKER_NOTE);
  const signin = await fetch(`${servers.url}/signin`, {
    method: "POST",
    headers: { origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    redirect: "manual",
  });
  cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
  const bobIn = await fetch(`${servers.url}/signin`, {
    method: "POST",
    headers: { origin: servers.url },
    body: new URLSearchParams({ username: "bob", password: "a-good-passphrase" }),
    redirect: "manual",
  });
  bobCookie = (bobIn.headers.get("set-cookie") ?? "").split(";")[0]!;
}, 30_000);

afterAll(async () => {
  await servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

test("lists exactly the six asks, each with title, repository and why", async () => {
  const res = await fetch(`${servers.url}/review`, { headers: { cookie } });
  const body = await res.text();
  expect(res.status).toBe(200);
  const rows = body.split('<li').filter((r) => r.includes('class="row"') && !r.includes("Open the preview"));
  expect(rows.length).toBe(6);
  const find = (t: string) => rows.find((r) => r.includes(t))!;
  expect(find("Handed over pull")).toContain("three reviews asked for changes");
  expect(find("Stale pull")).toContain("waiting 30 hours");
  expect(find("Crew asked about this")).toContain("parked by the crew");
  for (const r of rows) expect(r).toContain("alice/wait");
  expect(body).not.toContain("Young crew pull");
  expect(body).toContain("/alice/wait/pulls/");
  expect(body).toContain("/alice/wait/issues/");
  const names = (res.headers.get("server-timing") ?? "").split(", ").map((p) => p.split(";")[0]!);
  expect(names).toEqual(expect.arrayContaining(["session", "asks", "render"]));
});

test("signed out, /review sends to sign-in", async () => {
  const res = await fetch(`${servers.url}/review`, { redirect: "manual" });
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toContain("/signin");
});

test("the asks page links to /review", async () => {
  const res = await fetch(`${servers.url}/asks`, { headers: { cookie } });
  expect(await res.text()).toContain('href="/review"');
});

test("each row says what the crew advises and why, or that it has not advised yet", async () => {
  const body = await (await fetch(`${servers.url}/review`, { headers: { cookie } })).text();
  const rows = body.split("<li").filter((r) => r.includes('class="row"'));
  const find = (t: string) => rows.find((r) => r.includes(t))!;
  expect(find("Stale pull")).toContain("The crew advises: change — rename the &lt;flag&gt;.");
  expect(find("Handed over pull")).toContain("The crew has not advised yet");
  expect(find("Crew asked about this")).toContain("The crew has not advised yet");
});

test("a pull's row shows its check verdict; one with no check says none", async () => {
  const body = await (await fetch(`${servers.url}/review`, { headers: { cookie } })).text();
  const rows = body.split("<li").filter((r) => r.includes('class="row"'));
  const find = (t: string) => rows.find((r) => r.includes(t))!;
  expect(find("Handed over pull")).toContain("Running");
  expect(find("Stale pull")).toContain("No check");
  expect(find("Fresh ok pull")).toContain("Passed");
  expect(find("Fresh failed pull")).toContain("Failed");
  expect(find("Fresh cancelled pull")).toContain("No check");
  expect(find("Fresh cancelled pull")).not.toContain("Cancelled");
  expect(find("Stale pull")).toContain("No check");
  expect(find("Stale pull")).not.toContain("Running");
});

test("a pull of an app links its preview beside the row, not inside it; an issue row has neither", async () => {
  const body = await (await fetch(`${servers.url}/review`, { headers: { cookie } })).text();
  const rows = body.split("<li").filter((r) => r.includes('class="row"'));
  const find = (t: string) => rows.find((r) => r.includes(t))!;
  const at = body.indexOf("Stale pull");
  const link = body.indexOf("/alice/wait/app/pull-", at);
  expect(link).toBeGreaterThan(at);
  expect(body.slice(at, link)).toContain("</a>");
  const issue = find("Crew asked about this");
  expect(issue).not.toContain("/app/pull-");
  expect(issue).not.toContain("badge");
  expect(issue).not.toContain("No check");
});

test("a pull with a look shows production beside its preview, outside the row's link; one without shows nothing", async () => {
  const body = await (await fetch(`${servers.url}/review`, { headers: { cookie } })).text();
  const block = (t: string) => {
    const at = body.indexOf(t);
    return body.slice(at, body.indexOf("</ul>", at));
  };
  const stale = block("Stale pull");
  expect(stale.match(/data-slot="thumb"/g)?.length).toBe(2);
  expect(stale).toContain('alt="Production look, before"');
  expect(stale).toContain('aria-label="Preview look, after: opens the pull"');
  expect(stale.match(/<a /g)?.length).toBe(3); // the preview link, the after thumb and the step word; the before one is no link
  expect(stale).toContain("/alice/wait/looks/production/");
  expect(stale).toContain('width="30" height="40"');
  expect(stale).toContain('loading="lazy"');
  expect(stale.indexOf('data-slot="thumb"')).toBeGreaterThan(stale.indexOf("</a>"));
  expect(block("Fresh ok pull")).not.toContain("data-slot");
});

test("a viewer who may not fetch the look sees no image and no link to it", async () => {
  const mineBody = await (await fetch(`${servers.url}/review`, { headers: { cookie: bobCookie } })).text();
  expect(mineBody).toContain("Assigned to bob");
  expect(mineBody).not.toContain("/looks/");
  expect(mineBody).not.toContain("data-slot");
  const owner = await (await fetch(`${servers.url}/review`, { headers: { cookie } })).text();
  expect(owner).not.toContain("Assigned to bob");
});

test("a pull's row says its diff is loading or unavailable, and unavailable once git failed; an issue row says neither", async () => {
  const rowsOf = async () =>
    (await (await fetch(`${servers.url}/review`, { headers: { cookie } })).text())
      .split("<li")
      .filter((r) => r.includes('class="row"'));
  const first = await rowsOf();
  // Earlier tests in this file may already have asked git; either way the page answered at once.
  expect(first.find((r) => r.includes("Stale pull"))!).toMatch(/Diff (loading — reload for the size|size unavailable)/);
  await settled(app);
  const second = await rowsOf();
  // The fixture pulls point at the zero oid, which git cannot diff.
  expect(second.find((r) => r.includes("Stale pull"))!).toContain("Diff size unavailable");
  expect(second.find((r) => r.includes("Stale pull"))!).not.toContain("Diff loading");
  expect(second.find((r) => r.includes("Crew asked about this"))!).not.toContain("Diff");
});

test("a kept stat is the sentence in the row's trail, singular for one file", async () => {
  const rowsOf = async () =>
    (await (await fetch(`${servers.url}/review`, { headers: { cookie } })).text())
      .split("<li")
      .filter((r) => r.includes('class="row"'));
  rememberStat(app, ZERO, ZERO, { files: 3, additions: 40, deletions: 7 });
  const many = (await rowsOf()).find((r) => r.includes("Stale pull"))!;
  expect(many).toContain("3 files changed, +40 −7");
  expect(many.slice(many.indexOf("row-trail"))).toContain("3 files changed, +40 −7");
  expect(many).not.toContain("Diff size unavailable");
  rememberStat(app, ZERO, ZERO, { files: 1, additions: 2, deletions: 0 });
  const one = (await rowsOf()).find((r) => r.includes("Stale pull"))!;
  expect(one).toContain("1 file changed, +2 −0");
  expect(one).not.toContain("1 files");
  expect((await rowsOf()).find((r) => r.includes("Crew asked about this"))!).not.toContain("changed");
});

test("each pull row says its step on the path, linked to /pipeline (#7783)", async () => {
  const html = (await (await fetch(`${servers.url}/review`, { headers: { cookie } })).text()).replace(/\s+/g, " ");
  // A pull whose check was cancelled is at check, and says why.
  expect(html).toContain(
    'data-step="check"><a href="/pipeline" title="Its check was cancelled.">Check</a> · Its check was cancelled.',
  );
});
