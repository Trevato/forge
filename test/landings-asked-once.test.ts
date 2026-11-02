import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/core/repos.ts";
import { createApp } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { repoDir } from "../src/git/repos.ts";
import { id } from "../src/kernel/id.ts";
import { forgetLive, readLandings } from "../src/release/landings.ts";

const dirs: string[] = [];
const saved = { path: process.env.PATH, commit: process.env.FORGE_COMMIT };
afterEach(() => {
  process.env.PATH = saved.path;
  if (saved.commit === undefined) delete process.env.FORGE_COMMIT;
  else process.env.FORGE_COMMIT = saved.commit;
  forgetLive();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
  return p.stdout.toString().trim();
}

describe("landings ask git once per merge commit", () => {
  test("a pull on its way costs no git on the next read; a new one is asked once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-asked-once-"));
    dirs.push(dir);
    const app = createApp({ dataDir: dir, port: 0 });
    const u = await createUser(app.db, { username: "alice", email: "a@forge.test", password: "a-good-passphrase", origin: "seed", trusted: true, adminIfFirst: true });
    if (!u.ok) throw new Error(u.error);
    const repo = await createRepo(app.db, app.reposRoot, { ownerId: u.value.id, name: "r", visibility: "public", description: "r" });
    if (!repo.ok) throw new Error(repo.error);
    const gitDir = repoDir(app.reposRoot, "alice", "r");
    const a = git(gitDir, "commit-tree", TREE, "-m", "a");
    const b = git(gitDir, "commit-tree", TREE, "-p", a, "-m", "b");
    const c = git(gitDir, "commit-tree", TREE, "-m", "c");
    const d = git(gitDir, "commit-tree", TREE, "-m", "d");
    let n = 0;
    const merge = (oid: string) => {
      n++;
      const at = new Date(Date.now() - (10 - n) * 60_000).toISOString();
      const issueId = id();
      app.db.query(`INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at) VALUES (?1, ?2, ?3, 'pull', 'P', '', ?4, 'closed', ?5)`).run(issueId, repo.value.id, n, u.value.id, at);
      app.db.query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id, merged_at, merged_oid) VALUES (?1, ?2, ?3, '', '', ?4, ?5, ?6)`).run(issueId, repo.value.defaultBranch, `b/${n}`, repo.value.id, at, oid);
    };

    // A `git` that logs its arguments, then runs the real one.
    const bin = join(dir, "bin");
    const log = join(dir, "git.log");
    mkdirSync(bin);
    const real = Bun.which("git") ?? "/usr/bin/git";
    writeFileSync(join(bin, "git"), `#!/bin/sh\necho "$@" >> ${log}\nexec ${real} "$@"\n`);
    chmodSync(join(bin, "git"), 0o755);
    process.env.PATH = `${bin}:${saved.path ?? ""}`;
    process.env.FORGE_COMMIT = b;
    (app.config as { forgeRepo?: string }).forgeRepo = "alice/r";
    const asks = (oid: string) => readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("merge-base") && l.includes(oid)).length;
    const mergeBases = () => readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("merge-base")).length;

    merge(a);
    merge(c); // not in the running commit: on its way
    const first = await readLandings(app);
    expect(first.live.map((l) => l.number)).toEqual([1]);
    expect(first.onItsWay.map((l) => l.number)).toEqual([2]);
    expect(asks(a)).toBe(1);
    expect(asks(c)).toBe(1);

    const before = readFileSync(log, "utf8");
    const second = await readLandings(app);
    expect(second.onItsWay.map((l) => l.number)).toEqual([2]);
    expect(readFileSync(log, "utf8")).toBe(before); // no git at all
    expect(mergeBases()).toBe(2);

    merge(d);
    const third = await readLandings(app);
    expect(third.onItsWay.map((l) => l.number).sort()).toEqual([2, 3]);
    expect(asks(d)).toBe(1);
    expect(asks(c)).toBe(1);
    expect(mergeBases()).toBe(3);
  });
});
