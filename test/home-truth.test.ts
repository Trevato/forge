/** The owner's home idle reason and waiting figures (#6872). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo, moveArchived } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { id } from "../src/kernel/id.ts";
import { repoDir } from "../src/git/repos.ts";
import { forgetLive, readLandings } from "../src/release/landings.ts";
import { homeTruth, idleReason } from "../src/system/home_truth.ts";

test("idleReason says nothing when every slot runs, even over the ceiling", () => {
  expect(idleReason({ running: 3, slots: 3 }, { todayUsd: 0, ceilingUsd: 10 })).toBeNull();
  expect(idleReason({ running: 4, slots: 3 }, { todayUsd: 99, ceilingUsd: 10 })).toBeNull();
});

test("idleReason: no slots first, then the ceiling, then no ready work", () => {
  expect(idleReason({ running: 0, slots: 0 }, { todayUsd: 99, ceilingUsd: 10 })).toBe("no slots set");
  expect(idleReason({ running: 1, slots: 3 }, { todayUsd: 10, ceilingUsd: 10 })).toBe("daily ceiling of $10 reached");
  expect(idleReason({ running: 1, slots: 3 }, { todayUsd: 12, ceilingUsd: 10 })).toBe("daily ceiling of $10 reached");
  expect(idleReason({ running: 1, slots: 3 }, { todayUsd: 9.99, ceilingUsd: 10 })).toBe("no ready work");
  expect(idleReason({ running: 0, slots: 3 }, { todayUsd: 0, ceilingUsd: 10 })).toBe("no ready work");
});

test("idleReason never answers the ceiling when there is none", () => {
  expect(idleReason({ running: 0, slots: 3 }, { todayUsd: 1e6, ceilingUsd: null })).toBe("no ready work");
});

let dataDir: string;
let app: App;
let owner: User;
let stranger: User;
const now = new Date("2026-10-27T12:00:00Z");

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-home-truth-"));
  app = createApp({ dataDir, port: 0 });
  const mk = async (name: string, first: boolean) => {
    const r = await createUser(app.db, { origin: "seed", trusted: true, username: name, email: `${name}@forge.local`, password: "a-good-passphrase", adminIfFirst: first });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  owner = await mk("keeper", true);
  stranger = await mk("stranger", false);
  const repos: Record<string, string> = {};
  for (const [name, visibility] of [["open", "public"], ["secret", "private"], ["shelved", "public"]] as const) {
    const r = await createRepo(app.db, app.reposRoot, { ownerId: owner.id, name, visibility, description: name });
    if (!r.ok) throw new Error(r.error);
    repos[name] = r.value.id;
  }
  // Open issues assigned to the stranger: an assignment is an ask of its own.
  const assign = (repo: string, title: string, at: string) => {
    const number = app.db.query<{ issue_seq: number }, [string]>("UPDATE repo SET issue_seq = issue_seq + 1 WHERE id = ?1 RETURNING issue_seq").get(repos[repo]!)!.issue_seq;
    app.db
      .query(`INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at, updated_at, assignee_id) VALUES (?1, ?2, ?3, 'issue', ?4, '', ?5, 'open', ?6, ?6, ?7)`)
      .run(id(), repos[repo]!, number, title, owner.id, at, stranger.id);
  };
  assign("open", "Newer", "2026-10-26T10:00:00.000Z");
  assign("open", "Older", "2026-10-25T08:00:00.000Z");
  assign("secret", "Hidden", "2026-10-01T00:00:00.000Z");
  assign("shelved", "Put away", "2026-09-01T00:00:00.000Z");
  moveArchived(app.db, repos.shelved!, true);
});

afterAll(async () => {
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("homeTruth counts only visible, unarchived asks and names the oldest time", () => {
  const w = homeTruth(app, stranger, now).waiting;
  expect(w.count).toBe(2);
  expect(w.oldestAt).toBe("2026-10-25T08:00:00.000Z");
});

test("homeTruth with nothing waiting has no oldest time", () => {
  expect(homeTruth(app, owner, now).waiting).toEqual({ count: 0, oldestAt: null });
});

test("homeTruth carries the idle reason beside the builders", () => {
  const t = homeTruth(app, owner, now);
  expect(t.builders.idle).toBe(idleReason(t.builders, t.spend));
});

// #11676: live is the commit this process runs, beside main's head and the gap between them.
test("homeTruth names the running commit apart from main's head, and how far behind it stands", async () => {
  const saved = { commit: process.env.FORGE_COMMIT, version: process.env.FORGE_VERSION, repo: app.config.forgeRepo };
  try {
    const made = await createRepo(app.db, app.reposRoot, { ownerId: owner.id, name: "forge", visibility: "public", description: "forge" });
    if (!made.ok) throw new Error(made.error);
    const repo = made.value;
    const dir = repoDir(app.reposRoot, owner.username, "forge");
    const git = (...args: string[]) =>
      Bun.spawnSync(["git", ...args], {
        cwd: dir,
        env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
      }).stdout.toString().trim();
    const TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    const a = git("commit-tree", TREE, "-m", "a");
    const b = git("commit-tree", TREE, "-p", a, "-m", "b");
    const c = git("commit-tree", TREE, "-p", b, "-m", "c");
    git("update-ref", `refs/heads/${repo.defaultBranch}`, c);
    let n = 0;
    const merge = (oid: string, minutesAgo: number) => {
      const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
      const number = ++n;
      const issueId = id();
      app.db.query(`INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at, updated_at) VALUES (?1, ?2, ?3, 'pull', 'P', '', ?4, 'closed', ?5, ?5)`).run(issueId, repo.id, number, owner.id, at);
      app.db.query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id, merged_at, merged_oid) VALUES (?1, ?2, ?3, '', '', ?4, ?5, ?6)`).run(issueId, repo.defaultBranch, `b/${number}`, repo.id, at, oid);
    };
    merge(a, 30);
    merge(b, 20);
    merge(c, 10);
    (app.config as { forgeRepo?: string }).forgeRepo = `${owner.username}/forge`;
    process.env.FORGE_VERSION = "1.2.3";

    process.env.FORGE_COMMIT = a;
    forgetLive();
    await readLandings(app);
    const behind = homeTruth(app, owner, now);
    expect(behind.live).toEqual({ sha: a, version: "1.2.3" });
    expect(behind.main).toEqual({ sha: c });
    expect(behind.behind).toEqual({ commits: 2, pulls: 2 });

    process.env.FORGE_COMMIT = c;
    await readLandings(app);
    const even = homeTruth(app, owner, now);
    expect(even.live).toEqual({ sha: c, version: "1.2.3" });
    expect(even.main).toEqual({ sha: c });
    expect(even.behind).toEqual({ commits: 0, pulls: 0 });
  } finally {
    for (const [k, v] of [["FORGE_COMMIT", saved.commit], ["FORGE_VERSION", saved.version]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (saved.repo === undefined) delete (app.config as { forgeRepo?: string }).forgeRepo;
    else (app.config as { forgeRepo?: string }).forgeRepo = saved.repo;
    forgetLive();
  }
});
