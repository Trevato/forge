import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo, forkRepo } from "../src/actions/repos.ts";
import { forkRelation, type ForkRelation } from "../src/core/following.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { convergeTitle } from "../src/crew/converge.ts";
import { createIssue } from "../src/core/issues.ts";
import { createApp, type App } from "../src/app.ts";
import { repoDir } from "../src/git/repos.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { forksScreen, takeOffer } from "../src/tui/screens/forks.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";
import { promote } from "./helpers/members.ts";

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

describe("takeOffer", () => {
  const parent = { ownerName: "alice", name: "app", detached: null } as unknown as Repo;
  const at = (behind: number, ahead: number, clean = true, conflicts: string[] = []) =>
    ({ parent, state: "diverged", behind, ahead, clean, conflicts }) as unknown as ForkRelation;

  test("says a fast-forward, a merge, or the converge issue", () => {
    expect(takeOffer(at(3, 0), true, true)).toBe("Fast-forward to alice/app: 3 commits.");
    expect(takeOffer(at(1, 2), true, true)).toBe("Merge 1 commit from alice/app; your 2 commits stay.");
    expect(takeOffer(at(1, 1, false, ["a.txt"]), true, true)).toContain("converge issue");
  });

  test("not behind, no parent, a frozen parent, a reader or an agent: no offer", () => {
    expect(takeOffer(at(0, 2), true, true)).toBeUndefined();
    expect(takeOffer(undefined, true, true)).toBeUndefined();
    const frozen = { ...at(2, 0), parent: { ...parent, detached: { detachedAt: null } } } as ForkRelation;
    expect(takeOffer(frozen, true, true)).toBeUndefined();
    expect(takeOffer(at(2, 0), false, true)).toBeUndefined();
    expect(takeOffer(at(2, 0), true, false)).toBeUndefined();
  });
});

describe("the terminal's forks screen takes the parent's updates with t", () => {
  let dataDir: string;
  let app: App;
  let upstream: Repo;
  let converge = 0;
  const users: Record<string, User> = {};

  const screenOf = async (who: string, owner: string, ...keys: string[]) => {
    const terminal = headlessTerminal(120, 30);
    const { app: tui, session } = createForgeApp(
      app,
      { sshUsername: who, remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user: users[who]! },
      { terminal, exitHooks: false },
    );
    tui.start();
    tui.ctx.push(forksScreen(session, tui.ctx, getRepo(app.db, owner, "app")!));
    await settleApp(tui);
    const frames: string[] = [tui.screen.toText()];
    for (const k of keys) {
      terminal.feed(k);
      await settleApp(tui);
      frames.push(tui.screen.toText());
    }
    tui.stop?.();
    return frames;
  };
  const behind = async (owner: string) =>
    (await forkRelation(app, getRepo(app.db, owner, "app")!, upstream))!.behind;
  const git = async (cwd: string, ...args: string[]) => {
    const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text();
    expect(await p.exited).toBe(0);
    return out.trim();
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-forks-take-"));
    app = createApp({ dataDir, port: 0 });
    for (const name of ["alice", "bob", "carol", "dan"]) {
      users[name] = must(
        await createUser(app.db, {
          origin: "seed",
          trusted: true,
          username: name,
          email: `${name}@f.dev`,
          password: "a-good-passphrase",
          adminIfFirst: name === "alice",
        }),
      );
      promote(app.db, users[name]!);
    }
    upstream = must(await createRepo(app, users["alice"]!, { name: "app", visibility: "public" }));
    must(await commitToBranch(app, users["alice"]!, upstream, { message: "one", files: [{ path: "a.txt", content: "a\n" }] }));
    must(await forkRepo(app, users["bob"]!, upstream));
    const dan = must(await forkRepo(app, users["dan"]!, upstream));
    must(
      await commitToBranch(app, users["dan"]!, dan, {
        message: "dan shared",
        files: [{ path: "shared.txt", content: "dan\n" }],
      }),
    );
    const before = await git(repoDir(app.reposRoot, "bob", "app"), "rev-parse", "refs/heads/main");
    must(
      await commitToBranch(app, users["alice"]!, upstream, {
        message: "two",
        files: [
          { path: "b.txt", content: "b\n" },
          { path: "shared.txt", content: "alice\n" },
        ],
      }),
    );
    // Bob's fork follows by itself; put it back where it was so it is behind only.
    for (let i = 0; i < 100 && (await behind("bob")) !== 0; i++) await Bun.sleep(50);
    if ((await behind("bob")) !== 0) throw new Error(`never came: still waiting while (await behind("bob")) !== 0`);
    await git(repoDir(app.reposRoot, "bob", "app"), "update-ref", "refs/heads/main", before);
    expect(await behind("bob")).toBe(1);
    converge = must(createIssue(app.db, { repoId: dan.id, authorId: users["dan"]!.id, title: convergeTitle(upstream) })).number;
  }, 60_000);

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a reader of the fork is not offered t, and pressing it moves nothing", async () => {
    const [first, after] = await screenOf("carol", "bob", "t");
    expect(first).toContain("1 behind");
    expect(first).not.toContain("take updates");
    expect(after).not.toContain("Fast-forward");
    expect(await behind("bob")).toBe(1);
  });

  test("a repository that follows nothing is not offered t", async () => {
    const [first] = await screenOf("alice", "alice");
    expect(first).not.toContain("take updates");
  });

  test("a cancelled confirm moves nothing", async () => {
    const [first, asked, cancelled] = await screenOf("bob", "bob", "t", "n");
    expect(first).toContain("take updates");
    expect(asked).toContain("Fast-forward to alice/app: 1 commit.");
    expect(cancelled).not.toContain("Fast-forward");
    expect(await behind("bob")).toBe(1);
  });

  test("t and a confirm fast-forward the fork, said in the following page's words", async () => {
    const frames = await screenOf("bob", "bob", "t", "y");
    expect(await behind("bob")).toBe(0);
    expect(frames.at(-1)).toContain("Took alice/app's updates: main is at");
    expect(frames.at(-1)).toContain("in step");
    expect(frames.at(-1)).not.toContain("take updates");
  });

  test("on a conflict the converge issue is said, and Enter opens it", async () => {
    const frames = await screenOf("dan", "dan", "t", "y", "\r");
    expect(frames[1]).toContain("Both sides changed shared.txt");
    expect(frames[2]).toContain("One file needs a decision (shared.txt)");
    expect(frames[2]).toContain(`converging on #${converge}`);
    expect(frames[3]).toContain(convergeTitle(upstream));
    expect(await behind("dan")).toBe(1);
  });
});
