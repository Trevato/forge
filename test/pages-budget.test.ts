/**
 * Every GET page, walked warm against a budget (#10535). The routes come from
 * `server.ts` and `settings_routes.ts` themselves, as in the Server-Timing
 * sweep, so a page is walked the day it is added.
 *
 * What a pull judges is counted work (`helpers/work.ts`, #7824): SQL
 * statements and git processes per page, which an N+1 raises in every run.
 * The clock is printed per phase and never judged here. A failure names the
 * route and its slowest Server-Timing phase. A route that needs an id the
 * fixture does not hold is listed by name, and `MAX_UNFIXTURED` pins how many
 * there may be: a new page needs a fixture, or the count is raised on purpose.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { startChatBuild } from "../src/core/chat_build.ts";
import { createConversation } from "../src/core/conversations.ts";
import { createIssue } from "../src/core/issues.ts";
import { pin } from "../src/core/pins.ts";
import { getRepo } from "../src/core/repos.ts";
import { recordStart } from "../src/core/starts.ts";
import { createUser, type User } from "../src/core/users.ts";
import { buildApiRouter, buildRouter, serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { promote } from "./helpers/members.ts";
import { proveAll } from "./helpers/verified.ts";
import { pageWork, type PageWork } from "./helpers/work.ts";

quietLogs();

/** Statements and git processes one warm page may cost unless listed below. */
const DEFAULT = { statements: 60, git: 8 };
/** Pages that cost more today, with the most they may: lower these, never raise them. */
const HEAVIER: Record<string, { statements?: number; git?: number }> = {
  "/:owner/:name/issues/:number": { statements: 70 },
  "/:owner/:name/next": { statements: 64 },
  "/:owner/:name/pulls/:number": { statements: 111 }, // +1: the header Talk count (#10327); +1: the landing line (#10860); +1: whether a reviewer is seated, read only when Require review is off and the pull would otherwise wait on one; the page loads no crew besides (#11666)
  "/board": { statements: 70 }, // +6: the money line (#510) — one settings read, then the month's and the 30 days' meter, storage and ledger reads; constant in the number of apps
  "/settings/capacity": { statements: 71 },
};

/** Patterns with no fixture today: lower this as fixtures are added, never raise it silently. */
const MAX_UNFIXTURED = 146;

/** Streams and live fragments: no page. */
const NOT_PAGES = new Set([
  "/events", "/system/stream", "/settings/teams/stream", "/fleet/graph/live",
  "/settings/traffic/scrapes/export", "/settings/backups/live", "/:owner/:name/stream",
  "/settings/origins/flows/:id/stream",
]);

/** Patterns with an id in them, and the path the fixture fills them with. */
const FIXTURE: Record<string, string> = {
  "/:owner/:name/issues/:number": "/alice/forge/issues/1",
  "/:owner/:name/pulls/:number": "/alice/forge/pulls/2",
  "/:owner/:name/display": "/alice/forge/display",
  "/api/v1/admin/machines/:machine/disks": "/api/v1/admin/machines/rack1/disks",
  "/claim/start/:token": "/claim/start/claim_fixture",
};

function registeredGets(): Set<string> {
  const found = new Set<string>();
  for (const router of [buildRouter(), buildApiRouter()])
    for (const r of router.routes()) if (r.method === "GET") found.add(r.pattern);
  return found;
}

/** Every GET pattern the routers hold, split into walked paths and patterns with no fixture. */
export function plan(): { walked: Array<[pattern: string, path: string]>; unfixtured: string[] } {
  const walked: Array<[string, string]> = [];
  const unfixtured: string[] = [];
  for (const p of [...registeredGets()].sort()) {
    if (NOT_PAGES.has(p) || p.startsWith("/assets/") || p.endsWith("/live") || p.includes("/__forge/")) continue;
    const path = FIXTURE[p] ?? p.replace(":owner", "alice").replace(":name", "forge");
    if (path.includes(":") || path.includes("*")) unfixtured.push(p);
    else walked.push([p, path]);
  }
  return { walked, unfixtured };
}

/** The findings for one page's measured work: each names the route and its slowest phase. */
export function judge(pattern: string, w: PageWork): string[] {
  const max = { ...DEFAULT, ...HEAVIER[pattern] };
  const slowest = w.phases[0] === undefined ? "no phases" : `slowest phase ${w.phases[0].name} ${w.phases[0].ms.toFixed(1)} ms`;
  const out: string[] = [];
  if (w.statements > max.statements) out.push(`${pattern}: ${w.statements} SQL statements, budget ${max.statements} (${slowest})`);
  if (w.git > max.git) out.push(`${pattern}: ${w.git} git processes, budget ${max.git} (${slowest})`);
  return out;
}

let root = "";
let app: App;
let servers: Servers;
let cookie = "";

async function user(name: string, first: boolean): Promise<User> {
  const u = await createUser(app.db, {
    origin: "seed", trusted: true, username: name, email: `${name}@forge.local`,
    password: "a-good-passphrase", adminIfFirst: first,
  });
  if (!u.ok) throw new Error(u.error);
  promote(app.db, u.value);
  return u.value;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-pages-budget-"));
  app = createApp({ dataDir: root, port: 0, forgeRepo: "alice/forge" });
  const alice = await user("alice", true);
  const bob = await user("bob", false);
  await user("carol", false);
  proveAll(app);
  for (const [who, name, visibility] of [
    [alice, "forge", "public"], [alice, "vault", "private"], [bob, "notes", "public"], [bob, "diary", "private"],
  ] as const) {
    const made = await createRepo(app, who, { name, visibility });
    if (!made.ok) throw new Error(String(made.error));
  }
  const forge = getRepo(app.db, "alice", "forge")!;
  const files = await commitToBranch(app, alice, forge, {
    message: "display",
    files: [
      { path: "README.md", content: "# forge\n" },
      { path: "display.json", content: JSON.stringify({ title: "Night", layout: "grid", sources: ["alice/forge"] }) },
    ],
  });
  if (!files.ok) throw new Error(JSON.stringify(files.error));
  pin(app.db, alice.id, forge.id);
  pin(app.db, alice.id, getRepo(app.db, "bob", "notes")!.id);
  const issue = createIssue(app.db, { repoId: forge.id, authorId: bob.id, title: "An issue", body: "body" });
  if (!issue.ok) throw new Error(issue.error);
  const pull = createIssue(app.db, { repoId: forge.id, authorId: bob.id, title: "A pull", body: "body", kind: "pull" });
  if (!pull.ok) throw new Error(pull.error);
  app.db.run("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid) VALUES (?1, 'main', 'topic', '', 'h')", [pull.value.id]);
  // A conversation that builds, with a version on its branch, for the two build reads.
  const talk = createConversation(app.db, alice.id);
  if (!talk.ok) throw new Error(talk.error);
  startChatBuild(app.db, talk.value.id, forge.id);
  const version = await commitToBranch(app, alice, forge, { branch: `talk-${talk.value.id}`, message: "A version", files: [{ path: "page.txt", content: "v1\n" }] } as never);
  if (!version.ok) throw new Error(JSON.stringify(version.error));
  FIXTURE["/api/v1/conversations/:id/build"] = `/api/v1/conversations/${talk.value.id}/build`;
  FIXTURE["/api/v1/conversations/:id/build/versions/:n/diff"] = `/api/v1/conversations/${talk.value.id}/build/versions/1/diff`;
  // An agent's start the claim page can show (`/claim/start/:token`): bob's, so no extra account joins the walk.
  recordStart(app.db, bob.id, "claim_fixture", "127.0.0.1");
  servers = await serve(app);
  const signin = await fetch(`${servers.url}/signin`, {
    method: "POST",
    headers: { origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    redirect: "manual",
  });
  cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
}, 60_000);
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

test("every GET page is within its counted work, warm, naming its slowest phase", async () => {
  const { walked, unfixtured } = plan();
  expect(walked.length).toBeGreaterThan(20);
  const findings: string[] = [];
  const table: string[] = [];
  const init = { headers: { cookie }, redirect: "manual" as const };
  for (const [pattern, path] of walked) {
    let w = await pageWork(app.db, `${servers.url}${path}`, init);
    // A page over budget is measured twice more: stray background work raises a count once, an N+1 every time.
    for (let again = 0; again < 2 && judge(pattern, w).length > 0; again++) {
      const next = await pageWork(app.db, `${servers.url}${path}`, init);
      if (next.statements + next.git < w.statements + w.git) w = next;
    }
    if (w.status >= 500) findings.push(`${pattern}: answered ${w.status}`);
    if (w.status >= 300) continue; // a redirect is not a page (see server-timing-sweep)
    const top = w.phases[0];
    table.push(`${pattern}\t${w.statements} sql\t${w.git} git\t${w.ms.toFixed(1)} ms\t${top ? `${top.name} ${top.ms.toFixed(1)}` : "-"}`);
    findings.push(...judge(pattern, w));
  }
  console.log(`pages walked warm (route, statements, git, clock, slowest phase):\n${table.join("\n")}`);
  console.log(`no fixture, not walked (${unfixtured.length}):\n${unfixtured.join("\n")}`);
  expect(findings).toEqual([]);
}, 300_000);

test("a page over its counted work is named with its route and slowest phase", () => {
  const w: PageWork = { status: 200, statements: 99, git: 20, ms: 400, phases: [{ name: "git", ms: 300 }, { name: "render", ms: 5 }] };
  expect(judge("/x", w)).toEqual([
    "/x: 99 SQL statements, budget 60 (slowest phase git 300.0 ms)",
    "/x: 20 git processes, budget 8 (slowest phase git 300.0 ms)",
  ]);
  expect(judge("/x", { ...w, statements: 3, git: 0, ms: 5 })).toEqual([]);
});

test("a route the fixture cannot fill is listed, not skipped silently", () => {
  const { walked, unfixtured } = plan();
  expect(unfixtured.length).toBeGreaterThan(0);
  expect(unfixtured.length).toBeLessThanOrEqual(MAX_UNFIXTURED);
  expect(unfixtured.every((p) => p.includes(":") || p.includes("*"))).toBe(true);
  expect(walked.some(([p]) => p === "/:owner/:name/issues/:number")).toBe(true);
});
