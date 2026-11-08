/** The variant deck draws Like and Dislike only for a writer, and each form posts to a route that accepts it. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createIssue, getIssueById } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";

describe("the variant deck", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let repo: Repo;
  const cookies: Record<string, string> = {};
  let n = 0;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-deck-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const mk = async (username: string, member: boolean, first = false) => {
      const r = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        allowReserved: true,
        email: `${username}@f.dev`,
        password: "a-good-passphrase",
        adminIfFirst: first,
      });
      if (!r.ok) throw new Error(r.error);
      if (member) promote(app.db, r.value);
      cookies[username] = `forge_session=${createSession(app.db, r.value.id).token}`;
      return r.value;
    };
    await mk("root", true, true);
    alice = await mk("alice", true);
    await mk("bob", true);
    await mk("guest", false);
    const r = await createRepo(app, alice, { name: "garden", visibility: "public" });
    if (!r.ok) throw new Error(`repo: ${JSON.stringify(r)}`);
    repo = r.value;
  });
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  /** Sibling pulls in one group, written straight to the tables. */
  function group(name: string, count: number): number[] {
    const numbers: number[] = [];
    for (let i = 0; i < count; i++) {
      const issue = createIssue(app.db, {
        repoId: repo.id,
        authorId: alice.id,
        title: `${name} variant ${++n}`,
        kind: "pull",
      });
      if (!issue.ok) throw new Error(issue.error);
      app.db
        .query(
          `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, variant_group)
           VALUES (?1, 'main', ?2, 'a', 'b', ?3)`,
        )
        .run(issue.value.id, `${name}-${i}`, name);
      numbers.push(issue.value.number);
    }
    return numbers;
  }

  function issueIdOf(num: number): string {
    return app.db
      .query<{ id: string }, [string, number]>("SELECT id FROM issue WHERE repo_id = ?1 AND number = ?2")
      .get(repo.id, num)!.id;
  }

  const votesOn = (num: number) =>
    app.db
      .query<{ answer: string; by: string }, [string]>(
        "SELECT answer, by FROM decision WHERE kind = 'lean' AND issue_id = ?1",
      )
      .all(issueIdOf(num));

  const path = (g: string) => `/alice/garden/variants/${g}`;
  const get = (g: string, who?: string) =>
    fetch(`${servers.url}${path(g)}`, {
      headers: who ? { cookie: cookies[who]! } : {},
      redirect: "manual",
    });
  const post = (url: string, who: string, form: Record<string, string> = {}, origin = servers.url) =>
    fetch(`${servers.url}${url}`, {
      method: "POST",
      headers: { cookie: cookies[who]!, origin },
      body: new URLSearchParams(form),
      redirect: "manual",
    });
  const cards = (body: string) => body.match(/class="variant-card"/g)?.length ?? 0;
  const actions = (body: string, kind: "like" | "dislike") =>
    [...body.matchAll(new RegExp(`<form class="${kind}" method="post" action="([^"]+)"`, "g"))].map((m) => m[1]!);

  test("a writer sees a card per open pull, each with a Like and a Dislike form that posts to its pull", async () => {
    const nums = group("writer-deck", 3);
    const res = await get("writer-deck", "alice");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(cards(body)).toBe(3);
    expect(actions(body, "like")).toEqual(nums.map((x) => `${path("writer-deck")}/${x}/like`));
    expect(actions(body, "dislike")).toEqual(nums.map((x) => `${path("writer-deck")}/${x}/dislike`));
    // Plain same-origin posts: relative actions, no foreign target.
    expect(body).not.toMatch(/<form class="(like|dislike)"[^>]*action="https?:/);
    // Every drawn route accepts the post; a cross-origin one is refused.
    const liked = await post(`${path("writer-deck")}/${nums[0]}/like`, "alice");
    expect(liked.status).toBe(303);
    expect(votesOn(nums[0]!)).toEqual([{ answer: "like", by: "alice" }]);
    expect(getIssueById(app.db, issueIdOf(nums[0]!))!.state).toBe("open");
    const foreign = await post(`${path("writer-deck")}/${nums[1]}/like`, "alice", {}, "https://evil.example");
    expect(foreign.status).toBe(403);
  });

  test("a reader without write and a guest see the cards and no vote forms", async () => {
    group("reader-deck", 2);
    for (const who of ["bob", "guest", undefined]) {
      const res = await get("reader-deck", who);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(cards(body)).toBe(2);
      expect(body).not.toContain('class="like"');
      expect(body).not.toContain('class="dislike"');
      expect(body).not.toMatch(/\/\d+\/like/);
    }
  });

  test("a reader's post is refused and closes nothing", async () => {
    const nums = group("refused-deck", 2);
    const res = await post(`${path("refused-deck")}/${nums[0]}/dislike`, "bob");
    expect(res.status).toBe(403);
    expect(getIssueById(app.db, issueIdOf(nums[0]!))!.state).toBe("open");
  });

  test("disliking as the writer closes that pull and the deck lists one card fewer", async () => {
    const nums = group("dislike-deck", 3);
    expect(cards(await (await get("dislike-deck", "alice")).text())).toBe(3);
    const res = await post(`${path("dislike-deck")}/${nums[1]}/dislike`, "alice", { reason: "too loud" });
    expect(res.status).toBe(303);
    expect(votesOn(nums[1]!)).toEqual([{ answer: "dislike", by: "alice" }]);
    expect(getIssueById(app.db, issueIdOf(nums[1]!))!.state).toBe("closed");
    const body = await (await get("dislike-deck", "alice")).text();
    expect(cards(body)).toBe(2);
    expect(actions(body, "dislike")).not.toContain(`${path("dislike-deck")}/${nums[1]}/dislike`);
  });

  test("a closed sibling is not drawn as votable, and posting to it votes nothing", async () => {
    const nums = group("closed-deck", 2);
    app.db.query("UPDATE issue SET state = 'closed' WHERE id = ?1").run(issueIdOf(nums[0]!));
    const body = await (await get("closed-deck", "alice")).text();
    expect(cards(body)).toBe(1);
    expect(actions(body, "like")).toEqual([`${path("closed-deck")}/${nums[1]}/like`]);
    const res = await post(`${path("closed-deck")}/${nums[0]}/like`, "alice");
    expect(res.status).toBe(303);
    expect(votesOn(nums[0]!)).toEqual([]);
  });

  test("a merged sibling is not drawn as votable", async () => {
    const nums = group("merged-deck", 2);
    app.db
      .query("UPDATE pull SET merged_at = ?2 WHERE issue_id = ?1")
      .run(issueIdOf(nums[0]!), new Date().toISOString());
    app.db.query("UPDATE issue SET state = 'closed' WHERE id = ?1").run(issueIdOf(nums[0]!));
    const body = await (await get("merged-deck", "alice")).text();
    expect(cards(body)).toBe(1);
    expect(body).not.toContain(`/${nums[0]}/like`);
    expect(body).not.toContain(`/${nums[0]}/dislike`);
  });
});
