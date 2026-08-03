import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
};

describe("forks", () => {
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
