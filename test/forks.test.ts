import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { followParents } from "../src/actions/forks.ts";
import { createApp, type App } from "../src/app.ts";
import { deleteRepo, getRepo } from "../src/core/repos.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "F",
  GIT_AUTHOR_EMAIL: "f@f.dev",
  GIT_COMMITTER_NAME: "F",
  GIT_COMMITTER_EMAIL: "f@f.dev",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  // The same reason the two above are neutered: an ambient GIT_CONFIG_COUNT
  // (a crew run hands git an `http.extraHeader` for *its* forge) would send
  // someone else's credential to the test server instead of the URL's.
  GIT_CONFIG_COUNT: "0",
};

describe("forks", () => {
  let unfollow: () => void;
  let dataDir: string;
  let work: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let aliceToken = "";
  let bobToken = "";

  async function gitOk(args: string[], cwd: string): Promise<string> {
    const p = Bun.spawn(["git", ...args], {
      cwd,
      env: gitEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
    return out.trim();
  }
  async function gitCode(args: string[], cwd: string): Promise<number> {
    const p = Bun.spawn(["git", ...args], {
      cwd,
      env: gitEnv,
      stdout: "ignore",
      stderr: "ignore",
    });
    return await p.exited;
  }

  async function mkUser(username: string): Promise<string> {
    await fetch(`${base}/api/v1/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username,
        email: `${username}@f.dev`,
        password: "fork-me-please",
      }),
    });
    return fetch(`${base}/api/v1/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username,
        password: "fork-me-please",
        name: "c",
        scope: "admin",
      }),
    })
      .then((r) => r.json())
      .then((j) => (j as { token: string }).token);
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-fork-"));
    work = await mkdtemp(join(tmpdir(), "forge-fork-work-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    unfollow = followParents(app);
    base = servers.url;
    aliceToken = await mkUser("alice");
    bobToken = await mkUser("bob");

    // Alice makes a public repo with a commit.
    await fetch(`${base}/api/v1/repos`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${aliceToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "app", visibility: "public" }),
    });
    const remote = `${base.replace("http://", `http://alice:${aliceToken}@`)}/alice/app.git`;
    await gitOk(["clone", remote, "app"], work);
    const dir = join(work, "app");
    await Bun.write(join(dir, "README.md"), "# original\n");
    await gitOk(["add", "."], dir);
    await gitOk(["commit", "-m", "seed"], dir);
    await gitOk(["push", "origin", "main"], dir);
  });

  afterAll(async () => {
    unfollow();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  test("bob forks alice's repo; it shares objects via alternates", async () => {
    const res = await fetch(`${base}/api/v1/repos/alice/app/forks`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bobToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
    const fork = (await res.json()) as {
      ownerName: string;
      name: string;
      forkParentId: string | null;
    };
    expect(fork.ownerName).toBe("bob");
    expect(fork.forkParentId).not.toBeNull();

    const forkDir = repoDir(join(dataDir, "repos"), "bob", "app");
    // Alternates present → objects are shared, not copied.
    expect(
      await Bun.file(join(forkDir, "objects", "info", "alternates")).exists(),
    ).toBe(true);
    // The fork carries the parent's history.
    const log = await gitOk(["-C", forkDir, "log", "--oneline"], work);
    expect(log).toContain("seed");
  });

  test("bob pushes to his fork; alice's repo is untouched", async () => {
    const forkRemote = `${base.replace("http://", `http://bob:${bobToken}@`)}/bob/app.git`;
    await gitOk(["clone", forkRemote, "bob-app"], work);
    const dir = join(work, "bob-app");
    await Bun.write(join(dir, "feature.txt"), "bob's work\n");
    await gitOk(["add", "."], dir);
    await gitOk(["commit", "-m", "bob feature"], dir);
    await gitOk(["push", "origin", "main"], dir);

    // The fork has bob's commit…
    const forkLog = await gitOk(
      ["-C", repoDir(join(dataDir, "repos"), "bob", "app"), "log", "--oneline"],
      work,
    );
    expect(forkLog).toContain("bob feature");
    // …but alice's repo does not.
    const aliceLog = await gitOk(
      [
        "-C",
        repoDir(join(dataDir, "repos"), "alice", "app"),
        "log",
        "--oneline",
      ],
      work,
    );
    expect(aliceLog).not.toContain("bob feature");
  });

  test("a fork follows its parent's default branch, fast-forward only", async () => {
    const carolToken = await mkUser("carol");
    const as = (token: string) => ({
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    });
    const forked = await fetch(`${base}/api/v1/repos/alice/app/forks`, {
      method: "POST",
      headers: as(carolToken),
      body: "{}",
    });
    expect(forked.status).toBe(201);
    const repos = join(dataDir, "repos");

    // Alice moves main; carol's untouched fork follows on its own.
    const dir = join(work, "app");
    await Bun.write(join(dir, "NEWS.md"), "moved\n");
    await gitOk(["add", "."], dir);
    await gitOk(["commit", "-m", "alice moves on"], dir);
    await gitOk(["push", "origin", "main"], dir);
    const aliceTip = (
      await gitOk(
        ["-C", repoDir(repos, "alice", "app"), "rev-parse", "main"],
        work,
      )
    ).trim();
    const deadline = Date.now() + 5_000;
    let carolTip = "";
    while (Date.now() < deadline) {
      carolTip = (
        await gitOk(
          ["-C", repoDir(repos, "carol", "app"), "rev-parse", "main"],
          work,
        )
      ).trim();
      if (carolTip === aliceTip) break;
      await Bun.sleep(50);
    }
    expect(carolTip).toBe(aliceTip);
    // Asked by hand, there is nothing left to do.
    const again = await fetch(`${base}/api/v1/repos/carol/app/sync`, {
      method: "POST",
      headers: as(carolToken),
      body: "{}",
    });
    expect(again.status).toBe(200);
    const answer = (await again.json()) as { updated: boolean; to: string };
    expect(answer.updated).toBe(false);
    expect(answer.to).toBe(aliceTip);

    // Bob committed on his fork's main: it is his to reconcile, and he is told.
    const bobBefore = (
      await gitOk(
        ["-C", repoDir(repos, "bob", "app"), "rev-parse", "main"],
        work,
      )
    ).trim();
    const refused = await fetch(`${base}/api/v1/repos/bob/app/sync`, {
      method: "POST",
      headers: as(bobToken),
      body: "{}",
    });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe(
      "diverged",
    );
    expect(
      (
        await gitOk(
          ["-C", repoDir(repos, "bob", "app"), "rev-parse", "main"],
          work,
        )
      ).trim(),
    ).toBe(bobBefore);
  });

  test("the About rail says how far a fork is from its parent", async () => {
    const as = (token: string) => ({
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    });
    async function signIn(username: string): Promise<string> {
      const res = await fetch(`${base}/signin`, {
        method: "POST",
        body: new URLSearchParams({ username, password: "fork-me-please" }),
        redirect: "manual",
      });
      return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    }
    async function rail(path: string, cookie: string): Promise<string> {
      const res = await fetch(`${base}${path}`, { headers: { cookie } });
      expect(res.status).toBe(200);
      return await res.text();
    }

    // Dan forks alice/app as it stands, so his copy starts level with it:
    // nothing to take, and nothing offered.
    const danToken = await mkUser("dan");
    const danCookie = await signIn("dan");
    expect(
      (
        await fetch(`${base}/api/v1/repos/alice/app/forks`, {
          method: "POST",
          headers: as(danToken),
          body: "{}",
        })
      ).status,
    ).toBe(201);
    const current = await rail("/dan/app", danCookie);
    expect(current).toContain("up to date");
    expect(current).not.toContain("Update from parent");

    // Alice moves on with nothing following her, which is how a fork ends up
    // behind: the page counts the commit it is missing and offers the update.
    unfollow();
    const dir = join(work, "app");
    await Bun.write(join(dir, "LATER.md"), "later\n");
    await gitOk(["add", "."], dir);
    await gitOk(["commit", "-m", "alice again"], dir);
    await gitOk(["push", "origin", "main"], dir);
    unfollow = followParents(app);

    const behind = await rail("/dan/app", danCookie);
    expect(behind).toContain("1 commit behind");
    expect(behind).toContain("Update from parent");

    // Bob committed on his fork and alice pushed twice since: an update would
    // be refused, so the page says why instead of offering one.
    const diverged = await rail("/bob/app", await signIn("bob"));
    expect(diverged).toContain("1 commit of its own");
    expect(diverged).toContain("2 behind");
    expect(diverged).not.toContain("Update from parent");
  });

  test("a stranger cannot fork a private repo", async () => {
    await fetch(`${base}/api/v1/repos`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${aliceToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "secret", visibility: "private" }),
    });
    const res = await fetch(`${base}/api/v1/repos/alice/secret/forks`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bobToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  test("double-forking is refused", async () => {
    const res = await fetch(`${base}/api/v1/repos/alice/app/forks`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bobToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe(
      "already_forked",
    );
  });

  test("deleting the parent detaches the fork, which survives standalone", async () => {
    const forkDir = repoDir(join(dataDir, "repos"), "bob", "app");
    const parent = getRepo(app.db, "alice", "app")!;

    // Delete the parent whose objects the fork borrows.
    const deleted = await deleteRepo(app.db, join(dataDir, "repos"), parent);
    expect(deleted.ok).toBe(true);

    // The fork's alternates link is gone (objects were absorbed)…
    expect(
      await Bun.file(join(forkDir, "objects", "info", "alternates")).exists(),
    ).toBe(false);
    // …its parent link is cleared…
    expect(getRepo(app.db, "bob", "app")!.forkParentId).toBeNull();
    // …and it is fully intact: git can still walk the original + bob's history
    // with strict connectivity (would fail if borrowed objects were lost).
    expect(
      await gitCode(["-C", forkDir, "fsck", "--connectivity-only"], work),
    ).toBe(0);
    const log = await gitOk(["-C", forkDir, "log", "--oneline"], work);
    expect(log).toContain("seed");
    expect(log).toContain("bob feature");
  });
});
