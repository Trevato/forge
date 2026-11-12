/**
 * Chapters (#11603): with one open the crew starts nothing outside it and the planner's new issues land
 * in the next; an item is struck only when its production proof passed; Ship it with items left moves
 * them, tags, writes notes and closes; afterwards the crew rests until a chapter is opened; a patch
 * chapter opens from a closed one; the owner's page walks open → cross off → ship → finished.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newApp } from "../src/actions/apps.ts";
import { close, draft, fill, open, patch } from "../src/actions/chapters.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createApp, type App } from "../src/app.ts";
import { addCrew, createAgentRow, getAgent } from "../src/core/agents.ts";
import { chapterOfIssue, forgetFrozenItems, getChapter, inheritChapter, itemsOf, nextName, patchName, progressOf } from "../src/core/chapters.ts";
import { createIssue, getIssue, type Issue } from "../src/core/issues.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { queueAgentRun } from "../src/crew/dispatch.ts";
import { runGit } from "../src/git/env.ts";
import { repoDir } from "../src/git/repos.ts";
import { commitFiles } from "../src/git/write.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { chapterScreen, chaptersCommands, chaptersScreen } from "../src/tui/screens/chapters.ts";
import type { Ctx, Screen } from "../src/tui/app/app.ts";
import type { Session } from "../src/tui/session.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("chapters", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let owner: User;
  let planner: User;
  let builder: User;
  let repo: Repo;
  let token = "";
  const issues: Issue[] = [];

  const mkIssue = (title: string, body = ""): Issue => {
    const made = createIssue(app.db, { repoId: repo.id, authorId: owner.id, title, body });
    if (!made.ok) throw new Error(String(made.error));
    return made.value;
  };
  const builderAgent = () => getAgent(app.db, builder.id)!;
  /** Whether the dispatcher queues a builder run on the issue; the run is cancelled so the next probe starts clean. */
  const starts = (issue: Issue): boolean => {
    const run = queueAgentRun(app, repo, issue, builderAgent(), "assigned");
    app.db.query("UPDATE run SET state = 'cancelled' WHERE repo_id = ?1").run(repo.id);
    return run !== undefined;
  };
  /** Merge a pull that closes `issue` and, when `proven`, record production's passing proof for it. */
  let pullNo = 5000;
  const land = (issue: Issue, proven: boolean) => {
    app.db.query("UPDATE issue SET state = 'closed', closed_at = ?2 WHERE id = ?1").run(issue.id, "2026-11-10T00:00:00.000Z");
    const n = ++pullNo;
    const pid = `pull${n}`;
    app.db
      .query(`INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state) VALUES (?1, ?2, ?3, 'pull', ?4, ?5, ?6, 'closed')`)
      .run(pid, repo.id, n, `Build #${issue.number}`, `Closes #${issue.number}`, builder.id);
    app.db
      .query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at) VALUES (?1, 'main', ?2, 'a', 'b', '2026-11-10T00:00:00.000Z')`)
      .run(pid, `b${n}`);
    if (proven)
      app.db
        .query(`INSERT INTO release (sha, repo_id, pull_number, ok, line, created_at) VALUES ('abc', ?1, ?2, 1, 'ok', '2026-11-11T08:00:00.000Z')`)
        .run(repo.id, n);
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-chapters-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    servers = await serve(app);
    const mk = async (username: string, agent: boolean, roles: string[] = []) => {
      const made = await createUser(app.db, {
        username,
        email: `${username}@forge.test`,
        ...(agent
          ? { agent: true, origin: "agent" as const }
          : { password: "a-good-passphrase", origin: "seed" as const, trusted: true, adminIfFirst: true }),
      });
      if (!made.ok) throw new Error(String(made.error));
      if (agent) createAgentRow(app.db, { userId: made.value.id, roles: roles as never });
      return made.value;
    };
    owner = await mk("alice", false);
    planner = await mk("plan", true, ["planner"]);
    builder = await mk("build", true, ["builder"]);
    const made = await newApp(app, owner, { name: "shop", description: "Words", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repo = getRepo(app.db, "alice", "shop")!;
    addCrew(app.db, repo.id, planner.id, owner.id, "planner");
    addCrew(app.db, repo.id, builder.id, owner.id, "builder");
    const c = await commitFiles(repoDir(app.reposRoot, "alice", "shop"), {
      branch: repo.defaultBranch,
      message: "first",
      files: [{ path: "README.md", content: "hello" }],
      author: { name: "T", email: "t@forge.test" },
    });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
    token = createToken(app.db, owner.id, "t", "rw").token;
    for (const t of ["a", "b", "c"]) issues.push(mkIssue(`Item ${t}`));
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  test("the chapter reads walk an index and sort nothing in SQL", () => {
    const sqls = [
      "SELECT i.id, i.number, i.title, i.state FROM chapter_item c JOIN issue i ON i.id = c.issue_id WHERE c.chapter_id = ?1",
      "SELECT c.* FROM chapter c JOIN chapter_item i ON i.chapter_id = c.id WHERE i.issue_id = ?1",
      "SELECT * FROM chapter WHERE repo_id = ?1 AND state = 'open'",
      "SELECT COUNT(*) AS n FROM run WHERE issue_id = ?1 AND state IN ('queued','running')",
    ];
    for (const sql of sqls) {
      const plan = app.db.query(`EXPLAIN QUERY PLAN ${sql}`).all("x").map((r) => (r as { detail: string }).detail);
      expect(plan.filter((d) => d.startsWith("SCAN") || d.includes("TEMP B-TREE"))).toEqual([]);
    }
  });

  test("names: the next chapter and the patch after one", () => {
    expect(nextName("v1.0.0")).toBe("v2.0.0");
    expect(patchName("v1.0.0")).toBe("v1.0.1");
    expect(patchName("v2")).toBe("v2.1");
  });

  test("with no chapter everything flows as before", () => {
    expect(starts(issues[0]!)).toBe(true);
  });

  test("only the owner drafts, opens and fills: a planner or a stranger is refused", () => {
    expect(draft(app, planner, repo, { name: "v1.0.0" })).toEqual({ ok: false, error: "forbidden" });
    expect(draft(app, undefined, repo, { name: "v1.0.0" })).toEqual({ ok: false, error: "forbidden" });
    expect(draft(app, owner, repo, { name: "bad name!" })).toEqual({ ok: false, error: "invalid_name" });
    expect(draft(app, owner, repo, { name: "v1.0.0", means: "x".repeat(301) })).toEqual({ ok: false, error: "means_too_long" });
    expect(draft(app, owner, repo, { name: "v1.0.0", means: "The shop takes an order." }).ok).toBe(true);
    expect(draft(app, owner, repo, { name: "v1.0.0" })).toEqual({ ok: false, error: "exists" });
    expect(draft(app, owner, repo, { name: "v2.0.0", means: "Payments." }).ok).toBe(true);
    expect(fill(app, planner, repo, "v1.0.0", issues[0]!.number, true)).toEqual({ ok: false, error: "forbidden" });
    expect(fill(app, owner, repo, "v1.0.0", issues[0]!.number, true).ok).toBe(true);
    expect(fill(app, owner, repo, "v1.0.0", issues[1]!.number, true).ok).toBe(true);
    expect(open(app, planner, repo, "v1.0.0")).toEqual({ ok: false, error: "forbidden" });
  });

  test("a drafted chapter holds nothing back until it is opened; open, the crew builds only what is in it", () => {
    expect(starts(issues[2]!)).toBe(true);
    expect(open(app, owner, repo, "v1.0.0").ok).toBe(true);
    expect(open(app, owner, repo, "v2.0.0")).toEqual({ ok: false, error: "already_open" });
    expect(starts(issues[0]!)).toBe(true);
    expect(starts(issues[1]!)).toBe(true);
    expect(starts(issues[2]!)).toBe(false);
    // The owner's act is recorded.
    const kinds = app.db.query<{ kind: string }, [string]>("SELECT kind FROM event WHERE repo_id = ?1 AND kind LIKE 'chapter.%'").all(repo.id).map((e) => e.kind);
    expect(kinds).toContain("chapter.item_added");
    expect(kinds).toContain("chapter.opened");
  });

  test("the planner's new issues land in the next chapter, a defect of a chapter item joins this one; it never adds scope", () => {
    const plain = openIssue(app, planner, repo, { title: "Someday idea" });
    const defect = openIssue(app, planner, repo, { title: "Order total is wrong", body: `Defect of #${issues[0]!.number}` });
    const elsewhere = openIssue(app, planner, repo, { title: "Odd", body: `Defect of #${issues[2]!.number}` });
    if (!plain.ok || !defect.ok || !elsewhere.ok) throw new Error("planner issues");
    expect(chapterOfIssue(app.db, plain.value.id)?.name).toBe("v2.0.0");
    expect(chapterOfIssue(app.db, defect.value.id)?.name).toBe("v1.0.0");
    expect(chapterOfIssue(app.db, elsewhere.value.id)?.name).toBe("v2.0.0");
    expect(starts(plain.value)).toBe(false);
    expect(starts(defect.value)).toBe(true);
    // A person's issue is theirs to place: it is not moved.
    const mine = openIssue(app, owner, repo, { title: "Mine" });
    if (!mine.ok) throw new Error("owner issue");
    expect(chapterOfIssue(app.db, mine.value.id)).toBeUndefined();
  });

  test("with no later chapter drafted a planner's issue waits behind Later, and parts of a split stay in their chapter", () => {
    const partOf = mkIssue("Part of a");
    inheritChapter(app.db, issues[0]!, [partOf], owner.id);
    expect(chapterOfIssue(app.db, partOf.id)?.name).toBe("v1.0.0");
    expect(chapterOfIssue(app.db, issues[0]!.id)?.name).toBe("v1.0.0");
  });

  test("an item is struck only when live and proven, not when its pull merged", () => {
    const chapter = getChapter(app.db, repo.id, "v1.0.0")!;
    const find = (n: number) => itemsOf(app.db, chapter).find((i) => i.number === n)!;
    expect(find(issues[0]!.number).status).not.toBe("done");
    land(issues[0]!, false);
    expect(find(issues[0]!.number).status).toBe("building");
    expect(find(issues[0]!.number).doneAt).toBeNull();
    land(issues[0]!, true);
    const done = find(issues[0]!.number);
    expect(done.status).toBe("done");
    expect(done.doneAt).toBe("2026-11-11T08:00:00.000Z");
    expect(done.builder).toBe("build");
    const progress = progressOf(chapter, itemsOf(app.db, chapter), new Date("2026-11-12T00:00:00.000Z"));
    expect(progress.done).toBe(1);
    expect(progress.finishesOn).not.toBeNull();
  });

  test("closing without Ship it refuses while items are left; Ship it tags, writes notes, moves what is left and closes", async () => {
    expect(await close(app, owner, repo, "v1.0.0", false)).toEqual({ ok: false, error: "unfinished" });
    expect(await close(app, planner, repo, "v1.0.0", true)).toEqual({ ok: false, error: "forbidden" });
    const shipped = await close(app, owner, repo, "v1.0.0", true, new Date("2026-11-12T12:00:00.000Z"));
    if (!shipped.ok) throw new Error(shipped.error);
    expect(shipped.value.state).toBe("closed");
    expect(shipped.value.notes).toContain("# v1.0.0");
    expect(shipped.value.notes).toContain("Item a");
    expect(shipped.value.notes).toContain("Built by build");
    expect(shipped.value.notes).toContain("## Moved to v2.0.0");
    expect(shipped.value.notes).toContain("Item b");
    const dir = repoDir(app.reposRoot, "alice", "shop");
    const tag = await runGit(["rev-parse", "refs/tags/v1.0.0^{commit}"], { cwd: dir });
    expect(tag.ok && tag.value.trim()).toBe(shipped.value.tagOid!);
    expect(chapterOfIssue(app.db, issues[1]!.id)?.name).toBe("v2.0.0");
    // The closed chapter keeps its list and cannot be reopened or changed.
    expect(chapterOfIssue(app.db, issues[0]!.id)?.name).toBe("v1.0.0");
    expect(open(app, owner, repo, "v1.0.0")).toEqual({ ok: false, error: "closed" });
    expect(fill(app, owner, repo, "v1.0.0", issues[2]!.number, true)).toEqual({ ok: false, error: "closed" });
    expect(await close(app, owner, repo, "v1.0.0", true)).toEqual({ ok: false, error: "closed" });
  });

  test("after closing the crew starts nothing until a chapter is opened; a patch chapter opens from the closed one", () => {
    expect(starts(issues[1]!)).toBe(false);
    expect(starts(issues[2]!)).toBe(false);
    const made = patch(app, owner, repo, "v1.0.0");
    if (!made.ok) throw new Error(made.error);
    expect(made.value.name).toBe("v1.0.1");
    expect(made.value.state).toBe("open");
    expect(made.value.patchOf).toBe(getChapter(app.db, repo.id, "v1.0.0")!.id);
    expect(patch(app, owner, repo, "v1.0.0")).toEqual({ ok: false, error: "already_open" });
    expect(starts(issues[1]!)).toBe(false); // in v2.0.0, which waits
    expect(fill(app, owner, repo, "v1.0.1", issues[1]!.number, true).ok).toBe(true);
    expect(starts(issues[1]!)).toBe(true);
    expect(getIssue(app.db, repo.id, issues[1]!.number)?.state).toBe("open");
  });

  test("the page and the API: open → cross off → ship → the finished page", async () => {
    const post = (path: string, form: string) =>
      fetch(`${servers.url}${path}`, {
        method: "POST",
        redirect: "manual",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded", origin: servers.url },
        body: form,
      });
    const get = async (path: string) => (await fetch(`${servers.url}${path}`, { headers: { authorization: `Bearer ${token}` } })).text();
    // Patch chapter v1.0.1 is open: finish its one item, then close the book on it.
    land(issues[1]!, true);
    const page = await get("/alice/shop/chapters/v1.0.1");
    expect(page).toContain("1 of 1 done");
    expect(page).toContain("<s>Item b</s>");
    expect(page).toContain("live 2026-11-11");
    expect((await fetch(`${servers.url}/alice/shop/chapters/v1.0.1/ship`, { method: "POST", redirect: "manual", headers: { authorization: `Bearer ${token}`, origin: "https://evil.example" } })).status).toBe(403);
    expect(getChapter(app.db, repo.id, "v1.0.1")?.state).toBe("open");
    expect((await post("/alice/shop/chapters/v1.0.1/ship", "")).status).toBeLessThan(400);
    const finished = await get("/alice/shop/chapters/v1.0.1");
    expect(finished).toContain("is finished");
    expect(finished).toContain("Open a patch chapter");
    expect(finished).toContain("Cost");
    const api = (await (await fetch(`${servers.url}/api/v1/repos/alice/shop/chapters`)).json()) as { chapters: { name: string; state: string; tag: { oid: string } | null }[] };
    expect(api.chapters.map((c) => `${c.name}:${c.state}`).sort()).toEqual(["v1.0.0:closed", "v1.0.1:closed", "v2.0.0:draft"]);
    expect(api.chapters.find((c) => c.name === "v1.0.1")?.tag?.oid).toHaveLength(40);
    // The API drafts and opens too, with a token and not without one.
    const json = (path: string, body: unknown, auth = true) =>
      fetch(`${servers.url}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    expect((await json("/api/v1/repos/alice/shop/chapters", { name: "v3" }, false)).status).toBe(401);
    expect((await json("/api/v1/repos/alice/shop/chapters", { name: "v3", means: "Later" })).status).toBe(201);
    expect((await json("/api/v1/repos/alice/shop/chapters/v2.0.0/open", {})).status).toBe(200);
    expect(starts(issues[2]!)).toBe(false);
    expect(getChapter(app.db, repo.id, "v2.0.0")?.state).toBe("open");
  });
  test("a public read costs one pass over the pulls, and a closed chapter's list is read once", () => {
    forgetFrozenItems();
    const closed = getChapter(app.db, repo.id, "v1.0.0")!;
    expect(closed.state).toBe("closed");
    let statements = 0;
    let scans = 0;
    const counting = new Proxy(app.db, {
      get(target, key) {
        if (key === "query")
          return (sql: string) => {
            statements++;
            if (sql.includes("LIKE")) scans++;
            return target.query(sql);
          };
        const v = Reflect.get(target, key) as unknown;
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const first = itemsOf(counting, closed);
    expect(first.length).toBeGreaterThan(0);
    expect(scans).toBeLessThanOrEqual(1);
    const after = statements;
    expect(itemsOf(counting, closed)).toBe(first);
    expect(statements).toBe(after);
  });

  test("a ship whose database step fails takes its tag back, so a retry can close the book", async () => {
    const open2 = getChapter(app.db, repo.id, "v2.0.0")!;
    expect(open2.state).toBe("open");
    const dir = repoDir(app.reposRoot, "alice", "shop");
    const tagged = async () => (await runGit(["rev-parse", "--verify", "--quiet", "refs/tags/v2.0.0"], { cwd: dir })).ok;
    app.db.exec("CREATE TRIGGER chapter_refuses BEFORE UPDATE ON chapter BEGIN SELECT RAISE(ABORT, 'refused'); END");
    const refused = await close(app, owner, repo, "v2.0.0", true);
    expect(refused.ok).toBe(false);
    expect(await tagged()).toBe(false);
    expect(getChapter(app.db, repo.id, "v2.0.0")?.state).toBe("open");
    app.db.exec("DROP TRIGGER chapter_refuses");
    const retried = await close(app, owner, repo, "v2.0.0", true);
    expect(retried.ok).toBe(true);
    expect(await tagged()).toBe(true);
  });

  describe("the terminal door", () => {
    const session = (user: User | undefined) => ({ user, db: app.db, app }) as unknown as Session;
    const rig = () => {
      const toasts: string[] = [];
      const pushed: Screen[] = [];
      const ctx = { toast: (t: string) => toasts.push(t), invalidate() {}, push: (sc: Screen) => pushed.push(sc), pop() {}, track: (p: Promise<unknown>) => p } as unknown as Ctx;
      return { toasts, pushed, ctx };
    };
    const typed = (sc: Screen, text: string) => {
      for (const ch of text) sc.key({ key: ch } as never);
      return sc.key({ key: "enter" } as never);
    };

    test("a person who does not administer the app is refused every act", () => {
      expect(chaptersCommands(session(undefined), rig().ctx, repo)).toHaveLength(1);
      for (const who of [planner, undefined]) {
        const { ctx, pushed } = rig();
        const screen = chaptersScreen(session(who), ctx, repo);
        screen.key({ key: "n" } as never);
        typed(pushed[0]!, "v77");
        expect(getChapter(app.db, repo.id, "v77")).toBeUndefined();
      }
    });

    test("the owner drafts, fills, opens and ships from the terminal, and each act is an event", async () => {
      const heard: string[] = [];
      const off = app.bus.subscribe((e) => heard.push(e.kind));
      const { ctx, pushed, toasts } = rig();
      const screen = chaptersScreen(session(owner), ctx, repo);
      screen.key({ key: "n" } as never);
      typed(pushed[0]!, "v8");
      expect(getChapter(app.db, repo.id, "v8")?.state).toBe("draft");
      const idx = (await import("../src/core/chapters.ts")).listChapters(app.db, repo.id).findIndex((c) => c.name === "v8");
      for (let i = 0; i < idx; i++) screen.key({ key: "j" } as never);
      screen.key({ key: "enter" } as never);
      const detail = pushed.at(-1)!;
      detail.key({ key: "a" } as never);
      typed(pushed.at(-1)!, String(issues[0]!.number));
      expect(chapterOfIssue(app.db, issues[0]!.id)?.name).toBe("v1.0.0"); // closed chapters hold their list
      detail.key({ key: "a" } as never);
      const extra = mkIssue("Item d");
      typed(pushed.at(-1)!, String(extra.number));
      expect(chapterOfIssue(app.db, extra.id)?.name).toBe("v8");
      detail.key({ key: "o" } as never);
      expect(toasts.at(-1)).toBe("v8 is open.");
      expect(getChapter(app.db, repo.id, "v8")?.state).toBe("open");
      detail.key({ key: "s" } as never);
      const ask = pushed.at(-1)!;
      ask.key({ key: "enter" } as never);
      await new Promise((r) => setTimeout(r, 300));
      expect(getChapter(app.db, repo.id, "v8")?.state).toBe("closed");
      off();
      expect(heard).toEqual(expect.arrayContaining(["chapter.drafted", "chapter.item_added", "chapter.opened", "chapter.closed"]));
      expect(chapterScreen(session(owner), ctx, repo, "v8").title).toContain("v8");
    });
  });
});
