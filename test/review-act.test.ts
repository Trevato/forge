/** `/review` acts: Merge, Close, Request changes and Reply, each by form POST, then on to the next ask. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { listComments } from "../src/core/issues.ts";
import { getPull } from "../src/core/pulls.ts";
import { listReviews } from "../src/core/reviews.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import type { Repo } from "../src/core/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { id } from "../src/kernel/id.ts";
import { orderedAsks, rowId } from "../src/web/studio/review_act.ts";
import { quietLogs } from "./helpers/globals.ts";
import { withScripts } from "./helpers/page-script.ts";

quietLogs();

const ZERO = "0".repeat(40);
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

let root = "";
let app: App;
let servers: Servers;
let cookie = "";
let alice: User;
let repo: Repo;
let age = 100;

/** A pull alice authored with a green check on its head: it asks her, `age` hours old (older asks come last). */
function seeded(title: string): number {
  const issueId = id();
  const number = app.db
    .query<{ issue_seq: number }, [string]>("UPDATE repo SET issue_seq = issue_seq + 1 WHERE id = ?1 RETURNING issue_seq")
    .get(repo.id)!.issue_seq;
  app.db
    .query(`INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at) VALUES (?1, ?2, ?3, 'pull', ?4, '', ?5, 'open', ?6)`)
    .run(issueId, repo.id, number, title, alice.id, hoursAgo(age--));
  app.db
    .query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id) VALUES (?1, 'main', ?2, ?3, ?3, ?4)`)
    .run(issueId, `b/${number}`, ZERO, repo.id);
  app.db
    .query(`INSERT INTO run (id, repo_id, kind, issue_id, commit_oid, state) VALUES (?1, ?2, 'check', ?3, ?4, 'ok')`)
    .run(id(), repo.id, issueId, ZERO);
  return number;
}

/** A real branch with one commit, opened as a pull, its head checked green or red. */
async function real(name: string, state: "ok" | "failed"): Promise<number> {
  const made = await commitToBranch(app, alice, repo, {
    branch: `feature/${name}`,
    base: "main",
    message: name,
    files: [{ path: `${name}.ts`, content: `export const n = "${name}";\n` }],
  });
  if (!made.ok) throw new Error(JSON.stringify(made.error));
  const opened = await openPull(app, alice, repo, { title: name, baseBranch: "main", headBranch: `feature/${name}` });
  if (!opened.ok) throw new Error(String(opened.error));
  const pull = getPull(app.db, repo.id, opened.value.number)!;
  const run = createRun(app.db, { repoId: repo.id, kind: "check", issueId: pull.id, env: `pull-${pull.number}`, commitOid: pull.headOid, reason: "pull" });
  claimRun(app.db, run.id);
  finishRun(app.db, run.id, { state, summary: state });
  return pull.number;
}

const act = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
  fetch(`${servers.url}/review/act`, {
    method: "POST",
    headers: { cookie, origin: servers.url, ...headers },
    body: new URLSearchParams({ repo: "alice/work", ...fields }),
    redirect: "manual",
  });

const numberOf = (a: ReturnType<typeof orderedAsks>[number]) => a.pull?.number ?? a.issue?.number;
const anchorOf = (n: number) => rowId(orderedAsks(app.db, alice).find((a) => numberOf(a) === n)!);

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-review-act-"));
  app = createApp({ dataDir: root, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, {
    username: "alice",
    email: "alice@forge.test",
    password: "a-good-passphrase",
    origin: "seed",
    trusted: true,
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error(made.error);
  alice = made.value;
  const r = await createRepo(app, alice, { name: "work", visibility: "private" });
  if (!r.ok) throw new Error(String(r.error));
  repo = r.value;
  const first = await commitToBranch(app, alice, repo, { message: "Start", files: [{ path: "README.md", content: "# work\n" }] });
  if (!first.ok) throw new Error(JSON.stringify(first.error));
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

test("each row offers the four actions as plain forms, and the keys are listed", async () => {
  const n = seeded("Offered");
  const page = await (await fetch(`${servers.url}/review`, { headers: { cookie } })).text();
  for (const verb of ["merge", "close", "changes", "reply"]) expect(page).toContain(`data-verb="${verb}"`);
  expect(page).toContain('action="/review/act"');
  expect(page).toContain(`id="${anchorOf(n)}"`);
  for (const k of ["m", "c", "r"]) expect(page).toContain(`data-shortcut="${k}"`);
  await act({ number: String(n), verb: "close" });
});

test("close closes the pull and points at the next ask, which is gone from the page for the acted one", async () => {
  const a = seeded("First to go");
  const b = seeded("Second in line");
  const res = await act({ number: String(a), verb: "close" });
  expect(res.status).toBe(303);
  expect(getPull(app.db, repo.id, a)!.state).toBe("closed");
  expect(res.headers.get("location")).toBe(`/review#${anchorOf(b)}`);
  const page = await (await fetch(`${servers.url}/review`, { headers: { cookie } })).text();
  expect(page).not.toContain("First to go");
  expect(page).toContain("Second in line");
  await act({ number: String(b), verb: "close" });
});

test("the last ask closed sends the person back to /review", async () => {
  const only = seeded("Alone");
  const res = await act({ number: String(only), verb: "close" });
  expect(res.headers.get("location")).toBe("/review");
});

test("request changes records the review and moves on", async () => {
  const a = seeded("Needs work");
  const b = seeded("After it");
  const res = await act({ number: String(a), verb: "changes", body: "Rename the flag." });
  expect(res.status).toBe(303);
  const pull = getPull(app.db, repo.id, a)!;
  const reviews = listReviews(app.db, pull.id);
  expect(reviews.some((r) => r.state === "changes_requested" && r.body === "Rename the flag.")).toBe(true);
  expect(res.headers.get("location")).toBe(`/review#${anchorOf(b)}`);
  await act({ number: String(b), verb: "close" });
});

test("reply posts a comment, and an empty one is refused where it was", async () => {
  const a = seeded("Talk to me");
  const empty = await act({ number: String(a), verb: "reply", body: "  " });
  expect(empty.status).toBe(303);
  expect(empty.headers.get("location")).toBe(`/review#${anchorOf(a)}`);
  expect(decodeURIComponent(empty.headers.get("set-cookie") ?? "")).toContain("needs something");
  const res = await act({ number: String(a), verb: "reply", body: "Looks fine to me." });
  expect(res.status).toBe(303);
  const pull = getPull(app.db, repo.id, a)!;
  expect(listComments(app.db, pull.id).some((c) => c.body === "Looks fine to me.")).toBe(true);
  await act({ number: String(a), verb: "close" });
});

test("merge lands a green pull through the gate", async () => {
  const n = await real("lands", "ok");
  const res = await act({ number: String(n), verb: "merge" });
  expect(res.status).toBe(303);
  expect(getPull(app.db, repo.id, n)!.mergedAt).not.toBeNull();
  expect(res.headers.get("location")).toMatch(/^\/review(#.*)?$/);
});

test("merge on a red check is refused with the gate's sentence, and nothing lands", async () => {
  app.db.query("UPDATE repo SET require_checks = 1 WHERE id = ?1").run(repo.id);
  const n = await real("red", "failed");
  const res = await act({ number: String(n), verb: "merge" });
  expect(res.status).toBe(303);
  expect(getPull(app.db, repo.id, n)!.mergedAt).toBeNull();
  expect(decodeURIComponent(res.headers.get("set-cookie") ?? "").replace(/\+/g, " ")).toContain("needs a passing deploy of its current head");
  app.db.query("UPDATE repo SET require_checks = 0 WHERE id = ?1").run(repo.id);
});

test("a cross-origin post, a stranger, and a bad verb change nothing", async () => {
  const n = seeded("Untouchable");
  expect((await act({ number: String(n), verb: "close" }, { origin: "https://evil.example" })).status).toBe(403);
  const anon = await fetch(`${servers.url}/review/act`, {
    method: "POST",
    headers: { origin: servers.url },
    body: new URLSearchParams({ repo: "alice/work", number: String(n), verb: "close" }),
    redirect: "manual",
  });
  expect(anon.headers.get("location") ?? "").toContain("/signin");
  const bad = await act({ number: String(n), verb: "delete" });
  expect(bad.status).toBe(303);
  expect(getPull(app.db, repo.id, n)!.state).toBe("open");
});

test("the key script ships only when there are asks, and sanitises the hash it focuses", async () => {
  const n = seeded("Keyed");
  const withAsks = await (await fetch(`${servers.url}/review`, { headers: { cookie } })).text();
  const asksAll = await withScripts(servers.url, withAsks);
  expect(asksAll).toContain("m: 'merge'");
  expect(asksAll).toContain("location.hash.replace(/[^#a-z0-9-]/g, '')");
  for (const a of orderedAsks(app.db, alice)) await act({ number: String(numberOf(a)), verb: "close" });
  expect(n).toBeGreaterThan(0);
  const empty = await (await fetch(`${servers.url}/review`, { headers: { cookie } })).text();
  expect(await withScripts(servers.url, empty)).not.toContain("m: 'merge'");
});
