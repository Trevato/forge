/**
 * A GitHub migration carries each milestone (#3829): title, description,
 * due date and state, once. The origin is the fake GitHub, seeded with two
 * milestones, one closed; carrying twice into the same repository makes
 * none more.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { getIssue } from "../src/core/issues.ts";
import { createUser } from "../src/core/users.ts";
import { carryConversations } from "../src/origins/carry.ts";
import { dueOf } from "../src/origins/milestones.ts";
import { GitHubProvider } from "../src/origins/providers/github.ts";
import { staticCredential } from "../src/origins/types.ts";
import { newFakeState, serveFakeForge, type FakeForge } from "./fake-origin.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("migrate carries milestones", () => {
  let dataDir: string;
  let app: App;
  let github: FakeForge;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-milestones-"));
    app = createApp({ dataDir, port: 0 });
    const state = newFakeState("github", "octo", "tok-secret-1234");
    state.repos.push({
      id: 1,
      fullName: "octo/gadgets",
      cloneUrl: "http://127.0.0.1/none.git",
    });
    state.issues.set("octo/gadgets", [
      { id: 11, number: 1, title: "A conversation", user: "mona" },
      { id: 12, number: 2, title: "In v1", user: "mona", milestone: 1 },
      { id: 13, number: 3, title: "Also v1", user: "mona", milestone: 1 },
      { id: 14, number: 4, title: "In v0", user: "mona", milestone: 2 },
    ]);
    state.milestones.set("octo/gadgets", [
      { number: 1, title: "v1", description: "The first cut.", dueOn: "2026-12-01T00:00:00Z" },
      { number: 2, title: "v0", description: "Done long ago.", dueOn: "2026-01-15T00:00:00Z", state: "closed" },
      { number: 3, title: "Someday" },
    ]);
    github = serveFakeForge(state);
  });
  afterAll(async () => {
    github.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("both milestones arrive with state and due date, and a second carry makes no more", async () => {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.test",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    const repo = await createRepo(app, made.value, { name: "gadgets" });
    if (!repo.ok) throw new Error(String(repo.error));
    const provider = new GitHubProvider(
      staticCredential({
        kind: "github",
        apiUrl: github.apiUrl,
        webUrl: github.url,
        token: "tok-secret-1234",
      }),
    );
    const carry = () =>
      carryConversations({
        db: app.db,
        provider,
        fullName: "octo/gadgets",
        repoId: repo.value.id,
        actorId: made.value.id,
      });

    const first = await carry();
    expect(first.error).toBe("");
    expect(first.milestones).toBe(3);
    const rows = app.db
      .query<{ origin_number: number; issue_id: string }, [string]>(
        "SELECT origin_number, issue_id FROM milestone_origin WHERE repo_id = ?1 ORDER BY origin_number",
      )
      .all(repo.value.id);
    expect(rows.map((r) => r.origin_number)).toEqual([1, 2, 3]);
    const waits = () =>
      app.db
        .query<{ m: number; n: number }, []>(
          `SELECT m.origin_number AS m, i.number AS n FROM issue_dependency d
             JOIN milestone_origin m ON m.issue_id = d.issue_id
             JOIN issue i ON i.id = d.blocked_by_id ORDER BY m, n`,
        )
        .all();
    const issues = rows.map((r) => {
      const issue = app.db
        .query<{ title: string; body: string; state: string }, [string]>(
          "SELECT title, body, state FROM issue WHERE id = ?1",
        )
        .get(r.issue_id)!;
      return issue;
    });
    expect(issues).toEqual([
      { title: "v1", body: "The first cut.", state: "open" },
      { title: "v0", body: "Done long ago.", state: "closed" },
      { title: "Someday", body: "", state: "open" },
    ]);
    // Issues 2 and 3 landed in v1, 4 in v0; the unfiled one in none.
    const members = waits().map((w) => [w.m, getIssue(app.db, repo.value.id, w.n)?.title]);
    expect(members).toEqual([
      [1, "In v1"],
      [1, "Also v1"],
      [2, "In v0"],
    ]);
    expect(dueOf(app.db, repo.value.id, 1)).toBe("2026-12-01T00:00:00.000Z");
    expect(dueOf(app.db, repo.value.id, 2)).toBe("2026-01-15T00:00:00.000Z");
    expect(dueOf(app.db, repo.value.id, 3)).toBeNull();
    // Their numbers sit past the origin's conversation, not on it.
    expect(getIssue(app.db, repo.value.id, 1)?.title).toBe("A conversation");

    const before = app.db.query<{ n: number }, []>("SELECT count(*) AS n FROM issue").get()!.n;
    const second = await carry();
    expect(second.milestones).toBe(0);
    expect(waits().length).toBe(3);
    expect(app.db.query<{ n: number }, []>("SELECT count(*) AS n FROM issue").get()!.n).toBe(before);
    expect(
      app.db.query<{ n: number }, []>("SELECT count(*) AS n FROM milestone_origin").get()!.n,
    ).toBe(3);
  });
});
