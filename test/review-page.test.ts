/** `/review` lists each ask waiting on a person as one row with its why. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addComment, openIssue } from "../src/actions/issues.ts";
import { addComment as addRawComment } from "../src/core/issues.ts";
import { addCrew, createAgentRow, setCrewRole } from "../src/core/agents.ts";
import { createRepo as createRepoRow } from "../src/core/repos.ts";
import { submitReview } from "../src/core/reviews.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { BREAKER_NOTE } from "../src/crew/breaker.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { id } from "../src/kernel/id.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const ZERO = "0".repeat(40);
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

let root = "";
let app: App;
let servers: Servers;
let cookie = "";

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
  setCrewRole(app.db, repo.id, reviewer.id, "reviewer");
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
}, 30_000);

afterAll(async () => {
  await servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

test("lists exactly the three asks, each with title, repository and why", async () => {
  const res = await fetch(`${servers.url}/review`, { headers: { cookie } });
  const body = await res.text();
  expect(res.status).toBe(200);
  const rows = body.split('<li').filter((r) => r.includes('class="row"'));
  expect(rows.length).toBe(3);
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
