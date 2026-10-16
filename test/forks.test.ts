import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commitToBranch,
  createRepo,
  deleteRepo,
  forkRepo,
  updateRepoSettings,
} from "../src/actions/repos.ts";
import { takeUpdates } from "../src/actions/forks.ts";
import { createApp, type App } from "../src/app.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { commitFiles } from "../src/git/write.ts";
import { resolveOid } from "../src/git/merge.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";

/**
 * The invariants, one line each (the old file proved them through git over
 * HTTP, a token and a sign-in per person, and a 50 ms poll):
 *  - a fork borrows its parent's objects, carries its history, and a push to
 *    it never reaches the parent;
 *  - a fork follows its parent's default branch on its own, fast-forward
 *    only; one with work of its own is refused and told so;
 *  - the About rail counts how far a fork is behind or ahead, and offers an
 *    update only when one can be taken;
 *  - the fork count and the list hold only forks the viewer may read;
 *  - a private repo cannot be forked by a stranger, nor forked twice;
 *  - a public fork never names a private parent to a stranger;
 *  - deleting the parent detaches the fork whole.
 * Dropped as duplicates of what git.test.ts and the API suites prove: the
 * clone/push wire itself, and the sync route's JSON shape.
 */

const PASSWORD = "a-good-passphrase";

describe("forks", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  const users: Record<string, User> = {};
  const cookies: Record<string, string> = { "": "forge_mode=dev" };
  let upstream: Repo;

  const dirOf = (repo: Repo) => repoDir(app.reposRoot, repo.ownerName, repo.name);
  const tip = (repo: Repo) => resolveOid(dirOf(repo), `refs/heads/${repo.defaultBranch}`);
  const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return r.value;
  };
  const forkAs = async (who: string, parent: Repo, name?: string) =>
    must(await forkRepo(app, users[who]!, parent, name));
  const commitAs = async (who: string, repo: Repo, file: string, message: string) =>
    must(
      await commitToBranch(app, users[who]!, repo, {
        message,
        files: [{ path: file, content: `${message}\n` }],
      }),
    );
  /** Pushes are followed in the background; give it turns of the event loop, not a clock. */
  const follows = async (fork: Repo, want: string | undefined) => {
    for (let turns = 0; turns < 5_000; turns++) {
      if ((await tip(fork)) === want) return true;
      await new Promise((resolve) => setImmediate(resolve));
    }
    return false;
  };
  const page = async (path: string, who = "") => {
    const res = await fetch(`${base}${path}`, { headers: { cookie: cookies[who]! } });
    expect(res.status).toBe(200);
    return await res.text();
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-fork-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    for (const name of ["alice", "bob", "carol", "dan"]) {
      const made = await createUser(app.db, {
        trusted: true,
        username: name,
        email: `${name}@f.dev`,
        password: PASSWORD,
        adminIfFirst: name === "alice",
      });
      users[name] = must(made);
      cookies[name] =
        `forge_session=${createSession(app.db, users[name]!.id).token}; forge_mode=dev`;
    }
    upstream = must(
      await createRepo(app, users["alice"]!, { name: "app", visibility: "public" }),
    );
    await commitAs("alice", upstream, "README.md", "seed");
  }, 60_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a fork borrows its parent's objects and a push to it never reaches the parent", async () => {
    const bob = await forkAs("bob", upstream);
    expect(bob.ownerName).toBe("bob");
    expect(bob.forkParentId).toBe(upstream.id);
    expect(
      await Bun.file(join(dirOf(bob), "objects", "info", "alternates")).exists(),
    ).toBe(true);
    const seed = await tip(upstream);
    expect(await tip(bob)).toBe(seed);

    await commitAs("bob", bob, "feature.txt", "bob feature");
    expect(await tip(bob)).not.toBe(seed);
    expect(await tip(upstream)).toBe(seed);
  });

  test("a fork follows its parent fast-forward only; one with work of its own is refused", async () => {
    const carol = await forkAs("carol", upstream);
    await commitAs("alice", upstream, "NEWS.md", "alice moves on");
    const moved = await tip(upstream);
    expect(await follows(carol, moved)).toBe(true);

    // Asked by hand, there is nothing left to do.
    const again = must(await takeUpdates(app, users["carol"]!, carol));
    expect(again.updated).toBe(false);
    expect(again.to).toBe(moved!);

    // The follower never merges: bob has work of his own and stays where he was.
    const bob = getRepo(app.db, "bob", "app")!;
    expect(await tip(bob)).not.toBe(moved);
  });

  test("Update from parent merges a diverged fork cleanly, and refuses a conflicting one untouched", async () => {
    const parent = must(
      await createRepo(app, users["alice"]!, { name: "lib", visibility: "public" }),
    );
    await commitAs("alice", parent, "README.md", "seed");
    const clean = await forkAs("carol", parent);
    const conflicting = await forkAs("dan", parent);
    await commitAs("carol", clean, "MINE.md", "carol's own");
    await commitAs("dan", conflicting, "README.md", "dan rewrote it");
    await commitAs("alice", parent, "README.md", "alice rewrote it");
    const parentTip = (await tip(parent))!;
    for (let turns = 0; turns < 200; turns++)
      await new Promise((resolve) => setImmediate(resolve)); // let the follower refuse

    const sync = (who: string, repo: Repo) =>
      fetch(`${base}/api/v1/repos/${repo.ownerName}/${repo.name}/sync`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${createToken(app.db, users[who]!.id, "t", "rw").token}`,
        },
      });
    const git = async (repo: Repo, ...args: string[]) =>
      (await Bun.$`git -C ${dirOf(repo)} ${args}`.text()).trim();

    const ownTip = (await tip(clean))!;
    const res = await sync("carol", clean);
    expect(res.status).toBe(200);
    const merged = (await res.json()) as { updated: boolean; merged: boolean; to: string };
    expect(merged.updated).toBe(true);
    expect(merged.merged).toBe(true);
    const mergeOid = (await tip(clean))!;
    expect(merged.to).toBe(mergeOid);
    expect((await git(clean, "rev-list", "--parents", "-n1", mergeOid)).split(" ").slice(1).sort()).toEqual(
      [ownTip, parentTip].sort(),
    );
    expect(await git(clean, "log", "-1", "--format=%an", mergeOid)).toBe("carol");
    // Merged once, there is nothing left to take.
    const again = (await (await sync("carol", clean)).json()) as { updated: boolean };
    expect(again.updated).toBe(false);

    const before = await tip(conflicting);
    const refused = await sync("dan", conflicting);
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as { error: string; files: string[] };
    expect(body.error).toBe("conflict");
    expect(body.files).toEqual(["README.md"]);
    expect(await tip(conflicting)).toBe(before);
  }, 30_000);

  test("the About rail says how far a fork is from its parent, and offers an update only when one can be taken", async () => {
    // Dan forks as upstream stands: level, nothing offered.
    await forkAs("dan", upstream);
    const current = await page("/dan/app", "dan");
    expect(current).toContain("up to date");
    expect(current).not.toContain("Update from parent");

    // Upstream's main moves with no push the forge saw (a follow that failed):
    // the fork is plainly behind and the page offers the update.
    must(
      await commitFiles(dirOf(upstream), {
        branch: "main",
        message: "alice again",
        files: [{ path: "LATER.md", content: "later\n" }],
        author: { name: "A", email: "a@f.dev" },
      }),
    );
    const behind = await page("/dan/app", "dan");
    expect(behind).toContain("1 commit behind");
    expect(behind).toContain("Take updates");

    // Bob has work of his own and is two behind: an update would be refused,
    // so the page says why instead of offering one.
    const diverged = await page("/bob/app", "bob");
    expect(diverged).toContain("1 of your own");
    expect(diverged).toContain("2 behind");
    expect(diverged).not.toContain("Update from parent");
  });

  test("the fork count opens the list, and counts only forks the viewer may read", async () => {
    const home = await page("/alice/app");
    expect(home).toContain('href="/alice/app/forks"');
    expect(home).toContain("3 forks");
    const listed = await page("/alice/app/forks");
    expect(listed).toContain("3 forks");
    for (const who of ["bob", "carol", "dan"])
      expect(listed).toContain(`href="/${who}/app"`);

    const quiet = await forkAs("alice", upstream, "app-quiet");
    must(await updateRepoSettings(app, users["alice"]!, quiet, { visibility: "private" }));
    expect(await page("/alice/app")).toContain("3 forks");
    expect(await page("/alice/app/forks")).not.toContain('href="/alice/app-quiet"');
    expect(await page("/alice/app", "alice")).toContain("4 forks");
  });

  test("a stranger cannot fork a private repo, and nobody forks a parent twice", async () => {
    const secret = must(
      await createRepo(app, users["alice"]!, { name: "secret", visibility: "private" }),
    );
    const refused = await forkRepo(app, users["bob"]!, secret);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toBe("not_found");

    const twice = await forkRepo(app, users["bob"]!, upstream);
    expect(twice.ok).toBe(false);
    if (!twice.ok) expect(twice.error).toBe("already_forked");
  });

  test("a public fork does not name a private parent to a stranger", async () => {
    const vault = must(
      await createRepo(app, users["alice"]!, { name: "vault", visibility: "private" }),
    );
    await commitAs("alice", vault, "README.md", "vault seed");
    const open = await forkAs("alice", vault, "vault-open");
    must(await updateRepoSettings(app, users["alice"]!, open, { visibility: "public" }));

    const stranger = await page("/alice/vault-open");
    expect(stranger).not.toContain("Fork of");
    expect(stranger).not.toContain('href="/alice/vault"');
    expect(stranger).not.toContain("up to date");

    const owner = await page("/alice/vault-open", "alice");
    expect(owner).toContain("Fork of");
    expect(owner).toContain('href="/alice/vault"');
    expect(owner).toContain("up to date");
  });

  test("deleting the parent detaches the fork, which survives whole", async () => {
    const bob = getRepo(app.db, "bob", "app")!;
    must(await deleteRepo(app, users["alice"]!, upstream));

    expect(
      await Bun.file(join(dirOf(bob), "objects", "info", "alternates")).exists(),
    ).toBe(false);
    expect(getRepo(app.db, "bob", "app")!.forkParentId).toBeNull();
    // Strict connectivity fails if any borrowed object was not absorbed.
    const fsck = Bun.spawn(["git", "-C", dirOf(bob), "fsck", "--connectivity-only"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await fsck.exited).toBe(0);
    const log = Bun.spawn(["git", "-C", dirOf(bob), "log", "--format=%s"], {
      stdout: "pipe",
    });
    const subjects = await new Response(log.stdout).text();
    expect(subjects).toContain("seed");
    expect(subjects).toContain("bob feature");
  });
});
