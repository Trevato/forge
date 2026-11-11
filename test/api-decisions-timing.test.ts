/** The API decisions read names its Server-Timing phases (#4894). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createIssue } from "../src/core/issues.ts";
import { recordDecision } from "../src/core/decisions.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, getUserById } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { requestTiming } from "./helpers/request-timing.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let cookie = "";

const cells = process.env["FORGE_CELLS"];

beforeAll(async () => {
  process.env["FORGE_CELLS"] = "off";
  dataDir = await mkdtemp(join(tmpdir(), "forge-api-decisions-timing-"));
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
  const alice = made.value;
  cookie = `forge_session=${createSession(app.db, alice.id).token}`;
  const repo = await createRepo(app, alice, { name: "r", visibility: "public" });
  if (!repo.ok) throw new Error(String(repo.error));
});
afterAll(async () => {
  await servers.stop();
  app.close();
  if (cells === undefined) delete process.env["FORGE_CELLS"];
  else process.env["FORGE_CELLS"] = cells;
  await rm(dataDir, { recursive: true, force: true });
});

async function phases(path: string): Promise<{ status: number; names: string[]; body: string }> {
  const res = await fetch(`${servers.url}${path}`, { headers: { cookie } });
  const body = await res.text();
  const names = requestTiming(res).split(", ").map((p) => p.split(";")[0]!);
  return { status: res.status, names: names.slice(names.indexOf("app") + 1), body };
}

test("the decisions read names session, decisions, render in order", async () => {
  const got = await phases("/api/v1/repos/alice/r/decisions");
  expect(got.status).toBe(200);
  expect(got.names).toEqual(["session", "decisions", "render"]);
  expect(Object.keys(JSON.parse(got.body))).toEqual(["decisions", "week", "next_cursor"]);
});

test("a missing repository is a 404 naming session", async () => {
  const got = await phases("/api/v1/repos/alice/nope/decisions");
  expect(got.status).toBe(404);
  expect(got.names).toEqual(["session"]);
});

test("decisions page: default 30, paging to the end, both 422s", async () => {
  const repo = app.db.query<{ id: string }, []>("SELECT id FROM repo WHERE name = 'r'").get()!;
  for (let i = 0; i < 65; i++)
    recordDecision(app.db, { kind: "next", repoId: repo.id, state: {}, answer: `a${i}`, p: 1, by: "rule", ms: 1 });
  const get = async (q = "") => {
    const res = await fetch(`${servers.url}/api/v1/repos/alice/r/decisions${q}`, { headers: { cookie } });
    return { status: res.status, body: (await res.json()) as any };
  };
  const first = await get();
  expect(first.body.decisions).toHaveLength(30);
  const seen: string[] = [];
  let page = first;
  for (;;) {
    seen.push(...page.body.decisions.map((d: { id: string }) => d.id));
    if (page.body.next_cursor === null) break;
    page = await get(`?limit=30&cursor=${page.body.next_cursor}`);
  }
  expect(seen).toHaveLength(65);
  expect(new Set(seen).size).toBe(65);
  expect((await get("?limit=0")).body.error).toBe("invalid_limit");
  expect((await get("?limit=101")).status).toBe(422);
  expect((await get("?limit=x")).status).toBe(422);
  const bad = await get("?cursor=nope");
  expect(bad.status).toBe(422);
  expect(bad.body.error).toBe("invalid_cursor");
});

test("decisions page: sealed rows are filtered before the page is cut; a cursor from another repository is refused", async () => {
  const alice = app.db.query<{ id: string }, []>("SELECT id FROM user WHERE username = 'alice'").get()!;
  const made = await createRepo(app, getUserById(app.db, alice.id)!, {
    name: "h",
    visibility: "public",
  });
  if (!made.ok) throw new Error(String(made.error));
  const repoId = made.value.id;
  const sealed = createIssue(app.db, { repoId, authorId: alice.id, title: "report", sealed: true });
  if (!sealed.ok) throw new Error(String(sealed.error));
  const open = createIssue(app.db, { repoId, authorId: alice.id, title: "plain" });
  if (!open.ok) throw new Error(String(open.error));
  const visible: string[] = [];
  const hidden = new Set<string>();
  // Two hidden rows to every visible one, so a slice-then-filter page comes up short.
  for (let i = 0; i < 12; i++) {
    for (const issueId of [sealed.value.id, sealed.value.id, open.value.id]) {
      const d = recordDecision(app.db, { kind: "next", repoId, issueId, state: {}, answer: `a${i}`, p: 1, by: "rule", ms: 1 });
      if (issueId === open.value.id) visible.push(d.id);
      else hidden.add(d.id);
    }
  }
  const guest = async (q: string) => {
    const res = await fetch(`${servers.url}/api/v1/repos/alice/h/decisions${q}`);
    return { status: res.status, body: (await res.json()) as any };
  };
  const seen: string[] = [];
  let q = "?limit=5";
  for (;;) {
    const page = await guest(q);
    expect(page.status).toBe(200);
    const ids = page.body.decisions.map((d: { id: string }) => d.id);
    for (const id of ids) expect(hidden.has(id)).toBe(false);
    seen.push(...ids);
    if (page.body.next_cursor === null) break;
    expect(ids).toHaveLength(5);
    q = `?limit=5&cursor=${page.body.next_cursor}`;
  }
  expect(seen.sort()).toEqual([...visible].sort());
  const other = app.db.query<{ id: string }, []>("SELECT id FROM decision WHERE repo_id != '" + repoId + "' LIMIT 1").get()!;
  const refused = await guest(`?cursor=${other.id}`);
  expect(refused.status).toBe(422);
  expect(refused.body.error).toBe("invalid_cursor");
});

test("decisions page: past the scan bound a page is short, and its cursor still reaches the visible row once", async () => {
  const alice = getUserById(app.db, app.db.query<{ id: string }, []>("SELECT id FROM user WHERE username = 'alice'").get()!.id)!;
  const made = await createRepo(app, alice, { name: "bound", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  const repoId = made.value.id;
  const sealed = createIssue(app.db, { repoId, authorId: alice.id, title: "report", sealed: true });
  const open = createIssue(app.db, { repoId, authorId: alice.id, title: "plain" });
  if (!sealed.ok || !open.ok) throw new Error("issue");
  const row = (issueId: string) =>
    recordDecision(app.db, { kind: "next", repoId, issueId, state: {}, answer: "a", p: 1, by: "rule", ms: 1 });
  const visibleId = row(open.value.id).id;
  for (let i = 0; i < 505; i++) row(sealed.value.id);
  const get = async (q: string) =>
    (await (await fetch(`${servers.url}/api/v1/repos/alice/bound/decisions${q}`)).json()) as any;
  const first = await get("?limit=5");
  expect(first.decisions).toEqual([]);
  expect(first.next_cursor).not.toBeNull();
  const seen: string[] = [];
  let page = first;
  while (page.next_cursor !== null) {
    page = await get(`?limit=5&cursor=${page.next_cursor}`);
    seen.push(...page.decisions.map((d: { id: string }) => d.id));
  }
  expect(seen).toEqual([visibleId]);
});
