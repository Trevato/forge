/**
 * A protected default branch takes a `git push` from its admins only, the
 * rule the web editor already keeps (`actions/contents.ts`): every other
 * writer — a person's account an outside agent drives included — lands
 * through a pull, which the forge merges by moving the ref itself (#2614).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { addTeamMember, createOrg, createTeam } from "../src/core/orgs.ts";
import { createRepo, updateRepoSettings, type Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { resolveOid } from "../src/git/merge.ts";
import { repoDir } from "../src/git/repos.ts";
import { commitFiles } from "../src/git/write.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { gitClientEnv } from "./helpers/git-client.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const clientEnv = gitClientEnv();

async function sh(args: string[], cwd: string) {
  const proc = Bun.spawn(args, { cwd, env: clientEnv, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: out.trim(), err: err.trim() };
}

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

describe("a protected default branch takes pushes from its admins only", () => {
  let dataDir: string;
  let work: string;
  let app: App;
  let servers: Servers;
  let repo: Repo;
  let founder: User;
  let writer: User;
  let writerClone = "";
  let founderClone = "";

  const mainTip = () =>
    resolveOid(repoDir(app.reposRoot, repo.ownerName, repo.name), "refs/heads/main");
  const commit = async (clone: string, file: string) => {
    await Bun.write(join(clone, file), `${file}\n`);
    expect((await sh(["git", "add", file], clone)).code).toBe(0);
    expect((await sh(["git", "commit", "-qm", file], clone)).code).toBe(0);
  };
  const protect = (on: boolean) => {
    repo = updateRepoSettings(app.db, repo, { protectDefault: on });
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-protected-push-"));
    work = await mkdtemp(join(tmpdir(), "forge-protected-push-work-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const seed = (username: string, adminIfFirst: boolean) =>
      createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst,
      });
    // The site admin is someone else: the founder is admin by the org alone.
    ok(await seed("siteadmin", true));
    founder = ok(await seed("carol", false));
    writer = ok(await seed("dave", false));
    const org = ok(createOrg(app.db, "acme", founder.id));
    const team = ok(createTeam(app.db, org.id, "writers", "write"));
    addTeamMember(app.db, team, writer.id);
    repo = ok(
      await createRepo(app.db, app.reposRoot, { ownerId: org.id, name: "app", visibility: "public" }),
    );
    ok(
      await commitFiles(repoDir(app.reposRoot, repo.ownerName, repo.name), {
        branch: "main",
        message: "seed",
        files: [{ path: "README.md", content: "hi\n" }],
        author: { name: "Founder", email: "founder@forge.local" },
      }),
    );
    const remote = (user: User) =>
      `${servers.url.replace("://", `://${user.username}:${createToken(app.db, user.id, "push", "rw").token}@`)}/acme/app.git`;
    writerClone = join(work, "writer");
    founderClone = join(work, "founder");
    expect((await sh(["git", "clone", "-q", remote(writer), writerClone], work)).code).toBe(0);
    expect((await sh(["git", "clone", "-q", remote(founder), founderClone], work)).code).toBe(0);
  }, 30_000);

  afterAll(async () => {
    servers?.stop();
    app?.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  test("unprotected, a writer's fast-forward to main still lands", async () => {
    protect(false);
    await commit(writerClone, "open.txt");
    expect((await sh(["git", "push", "-q", "origin", "HEAD:main"], writerClone)).code).toBe(0);
  });

  test("protected, a writer's push to main is refused with a line pointing at pulls", async () => {
    protect(true);
    const before = await mainTip();
    await commit(writerClone, "direct.txt");
    const pushed = await sh(["git", "push", "-q", "origin", "HEAD:main"], writerClone);
    expect(pushed.code).not.toBe(0);
    expect(pushed.err).toContain("main is protected: only its admins push it; open a pull from a branch");
    expect(await mainTip()).toBe(before);
  });

  test("protected, the writer's branch lands through a pull an admin merges", async () => {
    const branch = await sh(["git", "push", "-q", "origin", "HEAD:refs/heads/change"], writerClone);
    expect(branch.code).toBe(0);
    const pull = ok(
      await openPull(app, writer, repo, { title: "A change", baseBranch: "main", headBranch: "change" }),
    );
    ok(await mergePull(app, founder, repo, pull, "merge"));
    const landed = await sh(["git", "fetch", "-q", "origin"], writerClone);
    expect(landed.code).toBe(0);
    const contains = await sh(["git", "merge-base", "--is-ancestor", "HEAD", "origin/main"], writerClone);
    expect(contains.code).toBe(0);
  });

  test("protected, its admin's fast-forward to main lands", async () => {
    expect((await sh(["git", "pull", "-q", "--ff-only", "origin", "main"], founderClone)).code).toBe(0);
    await commit(founderClone, "admin.txt");
    expect((await sh(["git", "push", "-q", "origin", "HEAD:main"], founderClone)).code).toBe(0);
  });
});
