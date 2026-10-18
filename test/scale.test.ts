/**
 * Shape, not speed.
 *
 * A performance test that asserts milliseconds is a test that fails on a
 * loaded CI box and passes on a fast laptop while the query underneath it is
 * quietly quadratic. So nothing here is timed. Two things are asserted
 * instead, and both are properties rather than measurements:
 *
 * - **The plan.** `EXPLAIN QUERY PLAN` says whether SQLite is seeking an
 *   index or walking a table, and that answer does not depend on the
 *   machine, the load, or how much data happens to be present. A hot query
 *   that scans is a bug today and a fire next year.
 * - **The count.** A page of fifty rows must not issue fifty queries. Asked
 *   as "does the grouped helper give the same answer as the per-row one, in
 *   one query", it is a correctness test that happens to pin the cost.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import {
  openIssue,
  addComment,
  setIssueLabels,
} from "../src/actions/issues.ts";
import { createLabel, createRepo } from "../src/actions/repos.ts";
import { signUpProven as signUp } from "./helpers/verified.ts";
import {
  commentCounts,
  countComments,
  getIssuesByRef,
  issueCounts,
  issueRefKey,
  labelsFor,
  labelsForIssues,
  listIssues,
  searchIssuesVisibleTo,
} from "../src/core/issues.ts";
import { listEvents, listEventsVisibleTo } from "../src/core/events.ts";
import { getPull, mergedPullNumbers } from "../src/core/pulls.ts";
import { pin, pinnedRepoIds, isPinned } from "../src/core/pins.ts";
import { getRepoById, getReposByIds, type Repo } from "../src/core/repos.ts";
import { getUserById, getUsersByIds, hasAnyUser } from "../src/core/users.ts";
import { createToken, verifyToken } from "../src/core/tokens.ts";
import {
  closeAllReaders,
  readerFor,
  readerPoolSize,
  sweepReaderPool,
  closeReader,
} from "../src/git/read.ts";
import { quietLogs } from "./helpers/globals.ts";
import type { User } from "../src/core/users.ts";
import { promote } from "./helpers/members.ts";
import { seedAdmin } from "./helpers/admin.ts";

quietLogs();

/** The `detail` lines EXPLAIN QUERY PLAN produces for a statement. */
function plan(app: App, sql: string, params: (string | number)[] = []): string {
  return app.db
    .query<{ detail: string }, (string | number)[]>(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params)
    .map((row) => row.detail)
    .join("\n");
}

describe("the index carries the hot queries", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let bob: User;
  let repo: Repo;
  let privateRepo: Repo;
  const issueIds: string[] = [];

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-scale-"));
    app = createApp({ dataDir, port: 0 });

    const a = await seedAdmin(app, {
      username: "alice",
      email: "a@forge.test",
      password: "a-long-alice-password",
    });
    const b = await signUp(app, {
      username: "bob",
      email: "b@forge.test",
      password: "a-long-bob-password",
    });
    if (!a.ok || !b.ok) throw new Error("seed users");
    alice = a.value;
    bob = b.value;
    promote(app.db, bob);

    const made = await createRepo(app, alice, {
      name: "public-one",
      visibility: "public",
    });
    const hidden = await createRepo(app, bob, {
      name: "bobs-secret",
      visibility: "private",
    });
    if (!made.ok || !hidden.ok) throw new Error("seed repos");
    repo = made.value;
    privateRepo = hidden.value;

    const bug = createLabel(app, alice, repo, "bug", "d73a4a");
    const chore = createLabel(app, alice, repo, "chore", "0e8a16");
    if (!bug.ok || !chore.ok) throw new Error("seed labels");

    for (let i = 0; i < 40; i++) {
      const opened = openIssue(app, alice, repo, { title: `issue ${i}` });
      if (!opened.ok) throw new Error("seed issue");
      issueIds.push(opened.value.id);
      if (i % 2 === 0) {
        setIssueLabels(app, alice, repo, opened.value, [bug.value.id]);
      }
      if (i % 3 === 0) {
        setIssueLabels(app, alice, repo, opened.value, [
          bug.value.id,
          chore.value.id,
        ]);
      }
      for (let c = 0; c < i % 5; c++) {
        addComment(app, alice, repo, opened.value, `comment ${c}`);
      }
    }
    // Something in the private repo, so the visibility assertions have a
    // negative case rather than an empty one.
    openIssue(app, bob, privateRepo, { title: "the secret issue" });
  });

  afterAll(async () => {
    closeAllReaders();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("every conversation list seeks an index instead of scanning", () => {
    const open = plan(
      app,
      `SELECT issue.*, user.username AS author_name
       FROM issue JOIN user ON user.id = issue.author_id
       WHERE issue.repo_id = ?1 AND issue.kind = ?2 AND issue.state = ?3
       ORDER BY issue.number DESC LIMIT 50`,
      [repo.id, "issue", "open"],
    );
    expect(open).toContain("issue_repo_kind_state_number");
    expect(open).not.toContain("SCAN issue");
    // The order comes out of the index, so no sort is needed at all.
    expect(open).not.toContain("TEMP B-TREE");

    const all = plan(
      app,
      `SELECT issue.*, user.username AS author_name
       FROM issue JOIN user ON user.id = issue.author_id
       WHERE issue.repo_id = ?1 AND issue.kind = ?2
       ORDER BY issue.number DESC LIMIT 50`,
      [repo.id, "pull"],
    );
    expect(all).toContain("issue_repo_kind_number");
    expect(all).not.toContain("SCAN issue");
    expect(all).not.toContain("TEMP B-TREE");
  });

  test("comment counts come from a covering index, not the comment bodies", () => {
    const counts = plan(
      app,
      `SELECT issue_id, COUNT(*) AS n FROM comment
       WHERE kind = 'comment' AND issue_id IN (?1, ?2) GROUP BY issue_id`,
      [issueIds[0]!, issueIds[1]!],
    );
    expect(counts).toContain("COVERING INDEX comment_issue_kind");
    expect(counts).not.toContain("SCAN comment");
  });

  test("the tab counts are one grouped read over a covering index", () => {
    const counts = plan(
      app,
      "SELECT state, COUNT(*) AS n FROM issue WHERE repo_id = ?1 AND kind = ?2 GROUP BY state",
      [repo.id, "issue"],
    );
    expect(counts).toContain("COVERING INDEX");
    expect(counts).not.toContain("SCAN issue");
  });

  test("the delivery worker's queue read needs no sort", () => {
    const due = plan(
      app,
      `SELECT d.id FROM webhook_delivery d
       JOIN webhook w ON w.id = d.webhook_id
       JOIN event e ON e.id = d.event_id
       WHERE d.state = 'pending' AND (d.next_try_at IS NULL OR d.next_try_at <= ?1)
       ORDER BY d.id LIMIT 50`,
      [new Date().toISOString()],
    );
    expect(due).toContain("delivery_state_id");
    expect(due).not.toContain("TEMP B-TREE");
  });

  test("every event append finds its webhooks by index", () => {
    const hooks = plan(
      app,
      "SELECT id, kinds FROM webhook WHERE repo_id = ?1 AND active = 1",
      [repo.id],
    );
    expect(hooks).toContain("webhook_repo_active");
    expect(hooks).not.toContain("SCAN webhook");
  });

  test("pins are read newest-first without a sort", () => {
    const pins = plan(
      app,
      `SELECT pin.repo_id FROM pin WHERE pin.user_id = ?1
       ORDER BY pin.created_at DESC, pin.repo_id DESC`,
      [alice.id],
    );
    expect(pins).toContain("pin_user_created");
    expect(pins).not.toContain("TEMP B-TREE");
  });
});

describe("grouped reads answer exactly what the per-row ones did", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let repo: Repo;
  let issueIds: string[] = [];

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-grouped-"));
    app = createApp({ dataDir, port: 0 });
    const a = await seedAdmin(app, {
      username: "alice",
      email: "a@forge.test",
      password: "a-long-alice-password",
    });
    if (!a.ok) throw new Error("seed");
    alice = a.value;
    const made = await createRepo(app, alice, {
      name: "grouped",
      visibility: "public",
    });
    if (!made.ok) throw new Error("seed repo");
    repo = made.value;
    const bug = createLabel(app, alice, repo, "bug", "d73a4a");
    const chore = createLabel(app, alice, repo, "chore", "0e8a16");
    if (!bug.ok || !chore.ok) throw new Error("seed labels");
    for (let i = 0; i < 30; i++) {
      const opened = openIssue(app, alice, repo, { title: `row ${i}` });
      if (!opened.ok) throw new Error("seed issue");
      issueIds.push(opened.value.id);
      const labels = [
        ...(i % 2 === 0 ? [bug.value.id] : []),
        ...(i % 3 === 0 ? [chore.value.id] : []),
      ];
      if (labels.length > 0) {
        setIssueLabels(app, alice, repo, opened.value, labels);
      }
      for (let c = 0; c < i % 4; c++) {
        addComment(app, alice, repo, opened.value, `c${c}`);
      }
    }
  });

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("labelsForIssues matches labelsFor, row for row", () => {
    const grouped = labelsForIssues(app.db, issueIds);
    for (const issueId of issueIds) {
      expect(grouped.get(issueId) ?? []).toEqual(labelsFor(app.db, issueId));
    }
  });

  test("commentCounts matches countComments, row for row", () => {
    const grouped = commentCounts(app.db, issueIds);
    for (const issueId of issueIds) {
      expect(grouped.get(issueId) ?? 0).toBe(countComments(app.db, issueId));
    }
  });

  test("the grouped reads survive more ids than SQLite takes parameters", () => {
    // 400 per chunk; 1 200 ids is three chunks and proves the boundary is
    // handled rather than merely never reached in practice.
    const padded = [
      ...issueIds,
      ...Array.from({ length: 1_200 }, (_, i) => `absent-${i}`),
    ];
    const labels = labelsForIssues(app.db, padded);
    const counts = commentCounts(app.db, padded);
    expect(labels.size).toBeGreaterThan(0);
    for (const issueId of issueIds) {
      expect(labels.get(issueId) ?? []).toEqual(labelsFor(app.db, issueId));
      expect(counts.get(issueId) ?? 0).toBe(countComments(app.db, issueId));
    }
    // Ids that do not exist simply have no entry — never a phantom row.
    expect(labels.get("absent-0")).toBeUndefined();
    expect(counts.get("absent-0")).toBeUndefined();
  });

  test("issueCounts matches counting each state separately", () => {
    const grouped = issueCounts(app.db, repo.id, "issue");
    const open = listIssues(app.db, repo.id, {
      state: "open",
      limit: 200,
    }).length;
    const closed = listIssues(app.db, repo.id, {
      state: "closed",
      limit: 200,
    }).length;
    expect(grouped).toEqual({ open, closed });
  });

  test("getReposByIds and getUsersByIds match the one-at-a-time reads", () => {
    const repos = getReposByIds(app.db, [repo.id, "no-such-repo", repo.id]);
    expect(repos.get(repo.id)).toEqual(getRepoById(app.db, repo.id)!);
    expect(repos.get("no-such-repo")).toBeUndefined();
    // Duplicates are de-duplicated, not queried twice.
    expect(repos.size).toBe(1);

    const users = getUsersByIds(app.db, [alice.id, "nobody"]);
    expect(users.get(alice.id)).toEqual(getUserById(app.db, alice.id)!);
    expect(users.get("nobody")).toBeUndefined();
  });

  test("getIssuesByRef finds issues the way an activity feed addresses them", () => {
    const refs = [1, 2, 3, 999].map((number) => ({
      repoId: repo.id,
      number,
    }));
    const found = getIssuesByRef(app.db, refs);
    expect(found.get(issueRefKey(repo.id, 1))?.number).toBe(1);
    expect(found.get(issueRefKey(repo.id, 3))?.number).toBe(3);
    expect(found.get(issueRefKey(repo.id, 999))).toBeUndefined();
    expect(getIssuesByRef(app.db, []).size).toBe(0);
  });

  test("mergedPullNumbers matches asking each pull one at a time", async () => {
    const numbers: number[] = [];
    for (let i = 0; i < 6; i++) {
      const opened = openIssue(app, alice, repo, { title: `pull-ish ${i}` });
      if (!opened.ok) throw new Error("seed");
      // A pull row for the issue, half of them landed — the shape a list of
      // pulls renders a "merged" mark from.
      app.db
        .query(
          `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at)
           VALUES (?1, 'main', ?2, 'a', 'b', ?3)`,
        )
        .run(
          opened.value.id,
          `f${i}`,
          i % 2 === 0 ? new Date().toISOString() : null,
        );
      app.db
        .query("UPDATE issue SET kind = 'pull' WHERE id = ?1")
        .run(opened.value.id);
      numbers.push(opened.value.number);
    }
    const grouped = mergedPullNumbers(app.db, repo.id, numbers);
    for (const number of numbers) {
      const one = getPull(app.db, repo.id, number);
      expect(grouped.has(number)).toBe(one?.mergedAt != null);
    }
    // A number from another repo is never claimed as this repo's.
    expect(mergedPullNumbers(app.db, "elsewhere", numbers).size).toBe(0);
    expect(mergedPullNumbers(app.db, repo.id, []).size).toBe(0);
  });

  test("pinnedRepoIds matches isPinned for every repo", () => {
    pin(app.db, alice.id, repo.id);
    const pinned = pinnedRepoIds(app.db, alice.id);
    expect(pinned.has(repo.id)).toBe(isPinned(app.db, alice.id, repo.id));
    expect(pinned.has("elsewhere")).toBe(
      isPinned(app.db, alice.id, "elsewhere"),
    );
  });

  test("hasAnyUser agrees with counting, and stops at the first row", () => {
    expect(hasAnyUser(app.db)).toBe(true);
    const empty = createApp({ dataDir: join(dataDir, "empty"), port: 0 });
    expect(hasAnyUser(empty.db)).toBe(false);
    empty.close();
  });
});

describe("visibility is enforced in SQL, not after the fact", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let bob: User;
  let mine: Repo;
  let theirs: Repo;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-visible-"));
    app = createApp({ dataDir, port: 0 });
    // The *first* account on a fresh forge is the site admin, and a site
    // admin sees everything — which would make every assertion here vacuous.
    // So the admin is somebody else entirely, and alice is an ordinary user.
    // Not "root": that name is reserved now.
    const admin = await seedAdmin(app, {
      username: "keeper",
      email: "keeper@forge.test",
      password: "a-long-keeper-password",
    });
    if (!admin.ok) throw new Error(`the admin could not be made: ${admin.error}`);
    const a = await signUp(app, {
      username: "alice",
      email: "a@forge.test",
      password: "a-long-alice-password",
    });
    const b = await signUp(app, {
      username: "bob",
      email: "b@forge.test",
      password: "a-long-bob-password",
    });
    if (!a.ok || !b.ok) throw new Error("seed");
    alice = a.value;
    bob = b.value;
    promote(app.db, bob);
    const one = await createRepo(app, bob, {
      name: "open-book",
      visibility: "public",
    });
    const two = await createRepo(app, bob, {
      name: "sealed",
      visibility: "private",
    });
    if (!one.ok || !two.ok) throw new Error("seed repos");
    mine = one.value;
    theirs = two.value;
    // A wall of private activity in front of the one public event, which is
    // exactly the shape that made the old JavaScript filter return nothing.
    for (let i = 0; i < 100; i++) {
      openIssue(app, bob, theirs, { title: `private ${i}` });
    }
    openIssue(app, bob, mine, { title: "the public one" });
    for (let i = 0; i < 100; i++) {
      openIssue(app, bob, theirs, { title: `more private ${i}` });
    }
  });

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a feed shows what the viewer can see, however deep it is buried", () => {
    // The unfiltered read, capped the way the page used to cap it, sees only
    // private events — the whole feed would have been empty.
    const naive = listEvents(app.db, { limit: 40 }).filter(
      (event) => event.repoId === mine.id,
    );
    expect(naive).toHaveLength(0);

    const visible = listEventsVisibleTo(app.db, alice, { limit: 12 });
    expect(visible.length).toBeGreaterThan(0);
    // Not one event from a repo alice cannot read.
    expect(visible.every((event) => event.repoId === mine.id)).toBe(true);
  });

  test("bob sees his own private activity; an anonymous viewer sees none", () => {
    const asBob = listEventsVisibleTo(app.db, bob, { limit: 12 });
    expect(asBob.some((event) => event.repoId === theirs.id)).toBe(true);

    const anonymous = listEventsVisibleTo(app.db, undefined, { limit: 50 });
    expect(anonymous.every((event) => event.repoId === mine.id)).toBe(true);
  });

  test("search never returns a title from a repo the viewer cannot read", () => {
    const asAlice = searchIssuesVisibleTo(app.db, alice, "private", {
      limit: 100,
    });
    expect(asAlice).toHaveLength(0);

    const asBob = searchIssuesVisibleTo(app.db, bob, "private", { limit: 100 });
    expect(asBob.length).toBeGreaterThan(0);
    expect(asBob.every((hit) => hit.ownerName === "bob")).toBe(true);

    // And it reaches past the first page of repos, which the per-repo loop
    // it replaces could not do at all.
    const public_ = searchIssuesVisibleTo(app.db, alice, "the public one");
    expect(public_).toHaveLength(1);
    expect(public_[0]?.repoName).toBe("open-book");
  });

  test("an empty query is not a request for everything", () => {
    expect(searchIssuesVisibleTo(app.db, bob, "   ")).toHaveLength(0);
  });

  test("wildcards from a search box stay literal", () => {
    expect(searchIssuesVisibleTo(app.db, bob, "%")).toHaveLength(0);
    expect(searchIssuesVisibleTo(app.db, bob, "_rivate")).toHaveLength(0);
  });
});

describe("the cat-file reader pool", () => {
  let dataDir: string;
  let app: App;
  let repoPath = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-pool-"));
    app = createApp({ dataDir, port: 0 });
    const a = await seedAdmin(app, {
      username: "alice",
      email: "a@forge.test",
      password: "a-long-alice-password",
    });
    if (!a.ok) throw new Error("seed");
    const made = await createRepo(app, a.value, {
      name: "pooled",
      visibility: "public",
    });
    if (!made.ok) throw new Error("seed repo");
    repoPath = join(app.reposRoot, "alice", "pooled.git");
  });

  afterAll(async () => {
    closeAllReaders();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a repo gets one reader, however many times it is asked for", () => {
    closeAllReaders();
    const first = readerFor(repoPath);
    for (let i = 0; i < 100; i++) {
      expect(readerFor(repoPath)).toBe(first);
    }
    expect(readerPoolSize()).toBe(1);
  });

  test("an idle reader is evicted, so two thousand repos are not two thousand processes", () => {
    closeAllReaders();
    readerFor(repoPath);
    expect(readerPoolSize()).toBe(1);
    // Sweep with a clock far enough ahead that the idle window has passed.
    sweepReaderPool(Date.now() + 10 * 60_000);
    expect(readerPoolSize()).toBe(0);
  });

  test("a reader that is still being used survives the sweep", () => {
    closeAllReaders();
    readerFor(repoPath);
    sweepReaderPool(Date.now());
    expect(readerPoolSize()).toBe(1);
  });

  test("closing one repo's reader leaves the others alone", () => {
    closeAllReaders();
    readerFor(repoPath);
    readerFor(`${repoPath}-other`);
    expect(readerPoolSize()).toBe(2);
    closeReader(repoPath);
    expect(readerPoolSize()).toBe(1);
    // Closing something that was never pooled is a no-op, not a throw.
    closeReader("/nowhere");
    expect(readerPoolSize()).toBe(1);
  });
});

describe("a token in constant use is not a write per request", () => {
  test("last_used_at is recorded once, then left alone for a minute", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-touch-"));
    const app = createApp({ dataDir, port: 0 });
    try {
      const a = await signUp(app, {
        username: "alice",
        email: "a@forge.test",
        password: "a-long-alice-password",
      });
      if (!a.ok) throw new Error("seed");
      const minted = createToken(app.db, a.value.id, "hot", "ro");

      expect(verifyToken(app.db, minted.token).ok).toBe(true);
      const first = app.db
        .query<
          { last_used_at: string | null },
          [string]
        >("SELECT last_used_at FROM token WHERE id = ?1")
        .get(minted.id)!.last_used_at;
      expect(first).not.toBeNull();

      // A hundred more requests in the same minute must not write a hundred
      // times — this used to be the busiest write in the forge, for a
      // timestamp whose only reader is a settings page.
      for (let i = 0; i < 100; i++) verifyToken(app.db, minted.token);
      const after = app.db
        .query<
          { last_used_at: string | null },
          [string]
        >("SELECT last_used_at FROM token WHERE id = ?1")
        .get(minted.id)!.last_used_at;
      expect(after).toBe(first);

      // But a token used again after the window does get refreshed, or the
      // field would be a lie rather than merely coarse.
      //
      // Compared against the *backdated* value, never against `first`:
      // two writes inside the same millisecond produce identical ISO
      // strings, so `refreshed !== first` is a coin flip that comes up
      // heads on an idle laptop and tails on a loaded one. This asserts the
      // write happened, which is the actual claim.
      const backdated = new Date(Date.now() - 10 * 60_000).toISOString();
      app.db
        .query("UPDATE token SET last_used_at = ?1 WHERE id = ?2")
        .run(backdated, minted.id);
      verifyToken(app.db, minted.token);
      const refreshed = app.db
        .query<
          { last_used_at: string | null },
          [string]
        >("SELECT last_used_at FROM token WHERE id = ?1")
        .get(minted.id)!.last_used_at;
      expect(refreshed).not.toBe(backdated);
    } finally {
      app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
