/** `repo` with `view: "chapters"`: the page's states and progress sentence, and the page's refusal. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { draft, fill, open } from "../src/actions/chapters.ts";
import { createApp, type App } from "../src/app.ts";
import { createIssue } from "../src/core/issues.ts";
import { getChapter, itemsOf, progressOf, progressSentence } from "../src/core/chapters.ts";
import { getRepo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let alice: string;
let bob: string;
let n = 1;

const call = async (token: string, args: unknown) => {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: n++, method: "tools/call", params: { name: "repo", arguments: args } }),
  });
  const body: any = await res.json();
  const text: string = body.result.content[0].text;
  return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-chapters-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const mk = async (username: string, first = false) => {
    const u = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst: first });
    if (!u.ok) throw new Error(u.error);
    return u.value;
  };
  const a = await mk("alice", true);
  const b = await mk("bob");
  alice = createToken(app.db, a.id, "a", "admin").token;
  bob = createToken(app.db, b.id, "b", "admin").token;
  for (const [name, visibility] of [["pub", "public"], ["priv", "private"]] as const) {
    const made = await createRepo(app, a, { name, visibility });
    if (!made.ok) throw new Error(String(made.error));
    const repo = getRepo(app.db, "alice", name)!;
    const nums: number[] = [];
    for (const t of ["one", "two", "three"]) {
      const i = createIssue(app.db, { repoId: repo.id, authorId: a.id, title: t, body: "" });
      if (!i.ok) throw new Error("issue");
      nums.push(i.value.number);
    }
    expect(draft(app, a, repo, { name: "v1", means: "It works." }).ok).toBe(true);
    for (const num of nums) expect(fill(app, a, repo, "v1", num, true).ok).toBe(true);
    expect(open(app, a, repo, "v1").ok).toBe(true);
    const c = getChapter(app.db, repo.id, "v1")!;
    const [first, second] = itemsOf(app.db, c);
    // One done (closed by a merged, proven pull), one building (merged, not proven), one left.
    for (const [issue, proven, pn] of [[first!, true, 900], [second!, false, 901]] as const) {
      app.db.query("UPDATE issue SET state = 'closed', closed_at = '2026-11-10T00:00:00.000Z' WHERE id = ?1").run(issue.issueId);
      app.db.query(`INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state) VALUES (?1, ?2, ?3, 'pull', 'p', ?4, ?5, 'closed')`).run(`pl${pn}${name}`, repo.id, pn, `Closes #${issue.number}`, a.id);
      app.db.query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at) VALUES (?1, 'main', ?2, 'a', 'b', '2026-11-10T00:00:00.000Z')`).run(`pl${pn}${name}`, `b${pn}`);
      if (proven) app.db.query(`INSERT INTO release (sha, repo_id, pull_number, ok, line, created_at) VALUES ('abc', ?1, ?2, 1, 'ok', '2026-11-11T08:00:00.000Z')`).run(repo.id, pn);
    }
  }
}, 30_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("the list names each chapter with its state", async () => {
  const r = await call(alice, { repo: "alice/pub", view: "chapters" });
  expect(r.value.chapters).toEqual([{ name: "v1", means: "It works.", state: "open" }]);
});

test("a named chapter answers done, building, left and the page's sentence", async () => {
  const r = await call(alice, { repo: "alice/pub", view: "chapters", chapter: "v1" });
  expect(r.value.items.map((i: any) => i.status).sort()).toEqual(["building", "done", "left"]);
  const repo = getRepo(app.db, "alice", "pub")!;
  const c = getChapter(app.db, repo.id, "v1")!;
  expect(r.value.progress).toBe(progressSentence(progressOf(c, itemsOf(app.db, c), new Date())));
  expect(r.value.progress).toStartWith("1 of 3 done");
  const page = await (await fetch(`${servers.url}/alice/pub/chapters/v1`, { headers: { authorization: `Bearer ${alice}` } })).text();
  expect(page).toContain(r.value.progress);
});

test("a private repository answers a stranger as the page does, and an unknown chapter is not found", async () => {
  const r = await call(bob, { repo: "alice/priv", view: "chapters" });
  expect(r.error).toContain("no such app or repository");
  expect((await fetch(`${servers.url}/alice/priv/chapters`, { headers: { authorization: `Bearer ${bob}` } })).status).toBe(404);
  expect((await call(alice, { repo: "alice/pub", chapter: "v1" })).error).toContain("`chapter` needs `view: chapters`");
  expect((await call(alice, { repo: "alice/priv", view: "chapters" })).value.chapters.length).toBe(1);
  expect((await call(alice, { repo: "alice/pub", view: "chapters", chapter: "nope" })).error).toContain("no such chapter");
  expect((await call(alice, { repo: "alice/pub", view: "x" })).error).toContain("chapters");
});
