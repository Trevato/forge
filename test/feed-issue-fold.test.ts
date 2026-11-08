/**
 * A burst of issues from one author folds into one post: three or more in
 * two minutes, titles under it, cursor paging whole, one or two untouched.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createIssue } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { cursorOf, parseCursor, readFeed } from "../src/feed/feed.ts";
import { recordInteraction } from "../src/core/interactions.ts";
import { feedCard } from "../src/web/studio/feed.ts";
import { promote } from "./helpers/members.ts";

describe("folding a burst of issues", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let bob: User;
  let repo: Repo;

  const open = (who: User, title: string): string => {
    const made = createIssue(app.db, { repoId: repo.id, authorId: who.id, title });
    if (!made.ok) throw new Error(made.error);
    return app.bus.append({
      kind: "issue.opened",
      repoId: repo.id,
      actorId: who.id,
      payload: { number: made.value.number },
    }).id;
  };
  const posts = () => {
    const out = [];
    let cursor: { score: number; id: string } | undefined;
    for (let i = 0; i < 20; i++) {
      const page = readFeed(app.db, alice, { limit: 1, ...(cursor ? { cursor } : {}) });
      out.push(...page.items);
      if (page.next_cursor === null) break;
      cursor = parseCursor(page.next_cursor);
    }
    return out.filter((i) => i.app === `${repo.ownerName}/${repo.name}` && i.kind === "tell");
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-feed-fold-"));
    app = createApp({ dataDir, port: 0 });
    const mk = async (username: string, first = false) => {
      const r = await createUser(app.db, {
        origin: "seed", trusted: true, allowReserved: true, username, email: `${username}@forge.local`,
        password: "a-good-passphrase", adminIfFirst: first,
      });
      if (!r.ok) throw new Error(r.error);
      promote(app.db, r.value);
      return r.value;
    };
    await mk("root", true);
    alice = await mk("alice");
    bob = await mk("bob");
    const made = await createRepo(app, alice, { name: "plans", visibility: "public" });
    if (!made.ok) throw new Error("repo");
    repo = made.value;
  });
  afterAll(async () => {
    app.db.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("two issues keep their own posts", () => {
    open(alice, "one");
    open(alice, "two");
    const p = posts();
    expect(p).toHaveLength(2);
    expect(p.every((i) => i.what.startsWith("opened an issue"))).toBe(true);
  });

  test("ten from one author and one from another make two posts, paged without a duplicate", () => {
    for (let i = 3; i <= 10; i++) open(alice, `step ${i}`);
    open(bob, "bob's idea");
    const p = posts();
    // alice's first two are in the same burst: ten in all.
    expect(p).toHaveLength(2);
    const ids = p.map((i) => i.id);
    expect(new Set(ids).size).toBe(2);
    const folded = p.find((i) => i.what === `planned 10 issues in alice/plans`)!;
    expect(folded).toBeDefined();
    expect(folded.link).toBe("/alice/plans/map");
    expect(folded.lines).toHaveLength(3);
    expect(folded.lines![0]!.text).toBe("step 10");
    expect(folded.lines![0]!.link).toMatch(/^\/alice\/plans\/issues\/\d+$/);
    expect(folded.more).toBe(7);
    expect(p.find((i) => i.actor === "bob")!.what).toContain("bob's idea");
    expect(cursorOf(folded)).toContain("fold:");
  });

  test("the card shows the titles and `and 7 more`", () => {
    const folded = posts().find((i) => i.lines !== undefined)!;
    const html = String(feedCard(folded));
    expect(html).toContain("step 10");
    expect(html).toContain("and 7 more");
    // Drawn as the design's list of rows, not hand-rolled markup.
    expect(html).toContain('<ul class="list">');
    expect(html).not.toContain('class="small break"><li');
  });

  test("a dismissed folded post stays gone, even when another issue joins the burst", () => {
    const folded = posts().find((i) => i.lines !== undefined)!;
    recordInteraction(app.db, {
      viewerId: alice.id,
      itemId: folded.id,
      kind: "dismissed",
      repoId: repo.id,
      actorId: alice.id,
    });
    expect(posts().some((i) => i.lines !== undefined)).toBe(false);
    open(alice, "step 11");
    const after = posts();
    expect(after.some((i) => i.lines !== undefined)).toBe(false);
    expect(after.some((i) => i.what.includes("planned"))).toBe(false);
  });

  test("issues more than two minutes apart do not fold", () => {
    app.db.query("UPDATE event SET created_at = ?1 WHERE kind = 'issue.opened' AND actor_id = ?2").run(
      new Date(Date.now() - 3600_000).toISOString(), alice.id,
    );
    const ids = app.db.query<{ id: string }, [string]>("SELECT id FROM event WHERE kind = 'issue.opened' AND actor_id = ?1 ORDER BY id").all(alice.id);
    ids.forEach((r, i) =>
      app.db.query("UPDATE event SET created_at = ?1 WHERE id = ?2").run(new Date(Date.now() - 3600_000 + i * 180_000).toISOString(), r.id),
    );
    const mine = posts().filter((i) => i.actor === "alice");
    expect(mine).toHaveLength(11);
    expect(mine.every((i) => i.lines === undefined)).toBe(true);
  });
});
