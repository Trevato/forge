/** `repo` with `action`: open, fill and close a chapter through the MCP, previewed, receipted and refused in the page's words. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { CHAPTER_WORDS, close, draft, fill, open } from "../src/actions/chapters.ts";
import { createApp, type App } from "../src/app.ts";
import { createIssue } from "../src/core/issues.ts";
import { getChapter, itemsOf, listChapters } from "../src/core/chapters.ts";
import { getRepo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { runGit } from "../src/git/env.ts";
import { repoDir } from "../src/git/repos.ts";
import { commitFiles } from "../src/git/write.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let alice: string;
let aliceRo: string;
let bob: string;
let bot: string;
let nums: number[] = [];
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
const repo = () => getRepo(app.db, "alice", "pub")!;
const state = () => JSON.stringify(listChapters(app.db, repo().id).map((c) => [c.name, c.state, itemsOf(app.db, c).map((i) => i.number)]));

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-chapters-act-"));
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
  aliceRo = createToken(app.db, a.id, "r", "ro").token;
  bob = createToken(app.db, b.id, "b", "admin").token;
  const agent = await createUser(app.db, { origin: "agent", agent: true, username: "robo", email: "robo@forge.local" });
  if (agent.ok) app.db.query("UPDATE user SET is_admin = 1 WHERE id = ?1").run(agent.value.id);
  if (!agent.ok) throw new Error(agent.error);
  bot = createToken(app.db, agent.value.id, "x", "admin").token;
  const made = await createRepo(app, a, { name: "pub", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  const r = repo();
  const c = await commitFiles(repoDir(app.reposRoot, "alice", "pub"), {
    branch: r.defaultBranch, message: "first", files: [{ path: "README.md", content: "hi" }], author: { name: "T", email: "t@forge.test" },
  });
  if (!c.ok) throw new Error("commit");
  for (const t of ["one", "two"]) {
    const i = createIssue(app.db, { repoId: r.id, authorId: a.id, title: t, body: "" });
    if (!i.ok) throw new Error("issue");
    nums.push(i.value.number);
  }
  expect(draft(app, a, r, { name: "v1" }).ok).toBe(true);
}, 30_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("an unconfirmed act says what it would do and changes nothing", async () => {
  const before = state();
  const r = await call(alice, { repo: "alice/pub", action: "open", chapter: "v1" });
  expect(r.value.done).toBe(false);
  expect(r.value.says).toContain("Would open v1");
  const f = await call(aliceRo, { repo: "alice/pub", action: "add", chapter: "v1", number: nums[0] });
  expect(f.value.says).toContain(`Would add #${nums[0]} to v1`);
  expect(state()).toBe(before);
});

test("a non-owner is refused in the page's words, confirmed or not", async () => {
  for (const confirm of [false, true]) {
    const r = await call(bob, { repo: "alice/pub", action: "open", chapter: "v1", confirm });
    expect(r.error).toContain(CHAPTER_WORDS.forbidden);
  }
  expect((await call(bob, { repo: "alice/pub", action: "close", chapter: "v1" })).error).toContain(CHAPTER_WORDS.forbidden);
  expect(listChapters(app.db, repo().id)[0]!.state).toBe("draft");
  const ro = await call(aliceRo, { repo: "alice/pub", action: "open", chapter: "v1", confirm: true });
  expect(ro.error).toBe("forbidden: this token may read, not act");
  expect(listChapters(app.db, repo().id)[0]!.state).toBe("draft");
});

test("confirmed open and fill land; a refusal uses CHAPTER_WORDS", async () => {
  expect((await call(alice, { repo: "alice/pub", action: "open", chapter: "v1", confirm: true })).value.done).toBe(true);
  expect((await call(alice, { repo: "alice/pub", action: "open", chapter: "v1", confirm: true })).error).toContain(CHAPTER_WORDS.already_open);
  for (const num of nums) expect((await call(alice, { repo: "alice/pub", action: "add", chapter: "v1", number: num, confirm: true })).value.done).toBe(true);
  expect(itemsOf(app.db, getChapter(app.db, repo().id, "v1")!).length).toBe(2);
  expect((await call(alice, { repo: "alice/pub", action: "remove", chapter: "v1", number: nums[1], confirm: true })).value.done).toBe(true);
  expect((await call(alice, { repo: "alice/pub", action: "add", chapter: "v1", number: 999, confirm: true })).error).toContain(CHAPTER_WORDS.no_issue);
  expect((await call(alice, { repo: "alice/pub", action: "add", chapter: "v1", confirm: true })).error).toContain("number");
});

test("an unconfirmed close names the tag and what moves, and changes nothing; confirmed close lands it", async () => {
  expect((await call(alice, { repo: "alice/pub", action: "add", chapter: "v1", number: nums[1], confirm: true })).value.done).toBe(true);
  const before = state();
  const seen = await call(alice, { repo: "alice/pub", action: "close", chapter: "v1" });
  expect(seen.value.done).toBe(false);
  expect(seen.value.tag).toBe("v1");
  expect(seen.value.into).toBe("v2");
  expect(seen.value.moves.map((m: any) => m.number)).toEqual([...nums]);
  expect(state()).toBe(before);
  expect(getChapter(app.db, repo().id, "v1")!.state).toBe("open");
  expect((await runGit(["rev-parse", "--verify", "--quiet", "refs/tags/v1"], { cwd: repoDir(app.reposRoot, "alice", "pub") })).ok).toBe(false);

  const done = await call(alice, { repo: "alice/pub", action: "close", chapter: "v1", confirm: true });
  expect(done.value.done).toBe(true);
  const c = getChapter(app.db, repo().id, "v1")!;
  expect(c.state).toBe("closed");
  const next = getChapter(app.db, repo().id, "v2")!;
  expect(itemsOf(app.db, next).map((i) => i.number).sort()).toEqual([...nums].sort());
  expect((await runGit(["rev-parse", "--verify", "--quiet", "refs/tags/v1"], { cwd: repoDir(app.reposRoot, "alice", "pub") })).ok).toBe(true);
  expect((await call(alice, { repo: "alice/pub", action: "close", chapter: "v1" })).error).toContain(CHAPTER_WORDS.closed);
});

test("an agent that administers the repository is refused in the page's words, previewed or confirmed", async () => {
  for (const confirm of [false, true]) {
    const r = await call(bot, { repo: "alice/pub", action: "add", chapter: "v2", number: nums[0], confirm });
    expect(r.error).toContain(CHAPTER_WORDS.forbidden);
  }
  expect((await call(bot, { repo: "alice/pub", action: "close", chapter: "v2", confirm: true })).error).toContain(CHAPTER_WORDS.forbidden);
});

test("a preview refuses what the act refuses, for open, add and remove", async () => {
  const cases: [string, number | undefined][] = [["open", undefined], ["add", nums[0]], ["remove", nums[0]], ["add", 999], ["remove", nums[1]]];
  for (const chapter of ["v1", "v2", "v9"]) {
    for (const [action, number] of cases) {
      const args = { repo: "alice/pub", action, chapter, ...(number === undefined ? {} : { number }) };
      const seen = await call(alice, args);
      const did = await call(alice, { ...args, confirm: true });
      const at = `${action} ${chapter} ${number ?? ""}: ${seen.error ?? "previewed"} vs ${did.error ?? "done"}`;
      expect([at, seen.error === undefined]).toEqual([at, did.error === undefined]);
      if (seen.error !== undefined) expect(seen.error).toEqual(did.error as string);
    }
  }
});

test("an unfinished chapter is refused by the page's close, and a taken tag by the MCP's, each in its words", async () => {
  const r = repo();
  const a = getUserByName(app.db, "alice")!;
  expect(getChapter(app.db, r.id, "v2")!.state).toBe("open");
  expect(fill(app, a, r, "v2", nums[0]!, true).ok).toBe(true);
  const unfinished = await close(app, a, r, "v2", false);
  expect(!unfinished.ok && unfinished.error).toBe("unfinished");
  expect(CHAPTER_WORDS.unfinished).toContain("Items are still open");
  const dir = repoDir(app.reposRoot, "alice", "pub");
  const tip = await runGit(["rev-parse", `refs/heads/${r.defaultBranch}`], { cwd: dir });
  if (!tip.ok) throw new Error("tip");
  await runGit(["update-ref", "refs/tags/v2", tip.value.trim(), ""], { cwd: dir });
  const before = state();
  for (const confirm of [false, true]) {
    const taken = await call(alice, { repo: "alice/pub", action: "close", chapter: "v2", confirm });
    expect(taken.error).toContain(CHAPTER_WORDS.tag_exists);
  }
  expect(state()).toBe(before);
  expect(getChapter(app.db, r.id, "v2")!.state).toBe("open");
});

test("closing through the MCP leaves what the page's close leaves", async () => {
  const a = getUserByName(app.db, "alice")!;
  const made: string[] = [];
  for (const name of ["twin", "mcp"]) {
    const rp = await createRepo(app, a, { name, visibility: "public" });
    if (!rp.ok) throw new Error(String(rp.error));
    const r = getRepo(app.db, "alice", name)!;
    const c = await commitFiles(repoDir(app.reposRoot, "alice", name), {
      branch: r.defaultBranch, message: "first", files: [{ path: "README.md", content: "hi" }], author: { name: "T", email: "t@forge.test" },
    });
    if (!c.ok) throw new Error("commit");
    expect(draft(app, a, r, { name: "v1" }).ok).toBe(true);
    expect(open(app, a, r, "v1").ok).toBe(true);
    for (const t of ["x", "y"]) {
      const i = createIssue(app.db, { repoId: r.id, authorId: a.id, title: t, body: "" });
      if (!i.ok) throw new Error("issue");
      expect(fill(app, a, r, "v1", i.value.number, true).ok).toBe(true);
    }
    made.push(name);
  }
  const shape = async (name: string) => {
    const r = getRepo(app.db, "alice", name)!;
    const tag = await runGit(["rev-parse", "--verify", "--quiet", "refs/tags/v1^{commit}"], { cwd: repoDir(app.reposRoot, "alice", name) });
    const head = await runGit(["rev-parse", `refs/heads/${r.defaultBranch}`], { cwd: repoDir(app.reposRoot, "alice", name) });
    return {
      chapters: listChapters(app.db, r.id).map((c) => [c.name, c.state, c.tagOid === null ? null : "tip", itemsOf(app.db, c).map((i) => i.title)]),
      tagAtTip: tag.ok && head.ok && tag.value.trim() === head.value.trim(),
    };
  };
  expect((await close(app, a, getRepo(app.db, "alice", "twin")!, "v1", true)).ok).toBe(true);
  expect((await call(alice, { repo: "alice/mcp", action: "close", chapter: "v1", confirm: true })).value.done).toBe(true);
  const page = await shape("twin");
  expect(await shape("mcp")).toEqual(page);
  expect(page.tagAtTip).toBe(true);
});
