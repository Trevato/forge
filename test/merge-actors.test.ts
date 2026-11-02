/**
 * Everything a merge sets off writes as the merger or as nobody (#5837): a
 * writer who is no admin merges a pull of someone else's in an organization's
 * repository whose autonomy is run by a third account, and every row the
 * merge wrote names only the merger — never the pull's author, the owner or
 * `autonomyBy`.
 *
 * What `mergePull` starts, and as whom:
 *   - the pull row closes as merged           merged_by = the merger
 *   - the decision to land resolves           no actor column
 *   - `pull.merged` on the outbox             actor = the merger
 *   - each issue the body closes closes       state only; `issue.closed` actor = the merger
 *   - subscribers of `pull.merged` (checks, previews, looks, crew, follow)
 *     read the event's actor and write as it, or write no row; the fork's
 *     converge close is its own test (`converge-settled.test.ts`), not run here
 *   - no comment, release or setting is written by a merge
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addTeamMember, createOrg, createTeam } from "../src/actions/orgs.ts";
import { openIssue } from "../src/actions/issues.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { getIssue } from "../src/core/issues.ts";
import { getOrg } from "../src/core/orgs.ts";
import { getRepoById, updateRepoSettings, type Repo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";
import { promote } from "./helpers/members.ts";
import { signUpProven as signUp } from "./helpers/verified.ts";

describe("a writer's merge writes nothing as anyone else", () => {
  let dataDir: string;
  let app: App;
  let owner: User;
  let bob: User;
  let carol: User;
  let dave: User;
  let repo: Repo;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-merge-actors-"));
    app = createApp({ dataDir, port: 0 });
    const made = await Promise.all(
      ["alice", "bob", "carol", "dave"].map((username) =>
        signUp(app, {
          username,
          email: `${username}@forge.test`,
          password: "a-long-passphrase",
        }),
      ),
    );
    if (!made.every((m) => m.ok)) throw new Error("sign-up failed");
    [owner, bob, carol, dave] = made.map((m) => (m.ok ? m.value : undefined!)) as [User, User, User, User];
    promote(app.db, owner, bob, carol, dave);
    expect(createOrg(app, owner, "acme").ok).toBe(true);
    const acme = getOrg(app.db, "acme")!;
    const devs = createTeam(app, owner, acme, "devs", "write");
    if (!devs.ok) throw new Error("team");
    for (const name of ["bob", "carol"])
      expect(addTeamMember(app, owner, acme, devs.value, name).ok).toBe(true);
    const r = await createRepo(app, owner, { owner: "acme", name: "site", visibility: "public" });
    if (!r.ok) throw new Error(String(r.error));
    repo = r.value;
    // The forge acts as dave when it runs on its own: he is never the merger.
    updateRepoSettings(app.db, repo, { autonomy: "autonomous", autonomyBy: dave.id });
    repo = getRepoById(app.db, repo.id)!;
  }, 30_000);

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const rows = <T>(sql: string): T[] => app.db.query<T, []>(sql).all();

  test("every row the merge wrote names the merger or the forge's system actor only", async () => {
    expect(
      (await commitToBranch(app, owner, repo, {
        message: "seed",
        files: [{ path: "README.md", content: "hello\n" }],
      })).ok,
    ).toBe(true);
    expect(
      (await commitToBranch(app, carol, repo, {
        branch: "feature",
        message: "feature",
        files: [{ path: "feature.txt", content: "yes\n" }],
      })).ok,
    ).toBe(true);
    const asked = openIssue(app, dave, repo, { title: "Add the feature" });
    if (!asked.ok) throw new Error("issue");
    const pull = await openPull(app, carol, repo, {
      title: "Feature",
      body: `Closes #${asked.value.number}`,
      baseBranch: "main",
      headBranch: "feature",
    });
    if (!pull.ok) throw new Error(String(pull.error));
    expect(bob.isAdmin).toBe(false);

    const settingsBefore = JSON.stringify(getRepoById(app.db, repo.id));
    const commentsBefore = rows<{ id: string }>("SELECT id FROM comment").length;
    const eventsBefore = rows<{ id: string }>("SELECT id FROM event").map((e) => e.id);

    const merged = await mergePull(app, bob, repo, pull.value, "squash");
    expect(merged.ok).toBe(true);
    // The issue it names is closed: the follow-up ran.
    expect(getIssue(app.db, repo.id, asked.value.number)?.state).toBe("closed");

    expect(
      rows<{ merged_by: string }>("SELECT merged_by FROM pull").map((r) => r.merged_by),
    ).toEqual([bob.id]);

    // Events: every one the merge wrote, actors only bob (or nobody).
    const wrote = rows<{ id: string; kind: string; actor_id: string | null }>(
      "SELECT id, kind, actor_id FROM event ORDER BY id",
    ).filter((e) => !eventsBefore.includes(e.id));
    expect(wrote.map((e) => e.kind)).toContain("pull.merged");
    expect(wrote.map((e) => e.kind)).toContain("issue.closed");
    for (const e of wrote)
      expect([bob.id, null], `${e.kind} was written as another account`).toContain(e.actor_id);

    // Comments: a merge writes none; and none under another name.
    const comments = rows<{ author_id: string }>("SELECT author_id FROM comment");
    expect(comments.length).toBe(commentsBefore);
    for (const c of comments) expect(c.author_id).not.toBe(dave.id);

    // Settings: untouched by a merge, `autonomyBy` included.
    expect(JSON.stringify(getRepoById(app.db, repo.id))).toBe(settingsBefore);
    expect(getRepoById(app.db, repo.id)?.autonomyBy).toBe(dave.id);
  });
});
