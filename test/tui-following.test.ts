import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo, forkRepo } from "../src/actions/repos.ts";
import { forkRelation, type ForkRelation } from "../src/core/following.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { convergeTitle, type Converge } from "../src/crew/converge.ts";
import { createIssue, type Issue } from "../src/core/issues.ts";
import type { Pull } from "../src/core/pulls.ts";
import { createApp, type App } from "../src/app.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { followingRows, forksScreen } from "../src/tui/screens/forks.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";
import { promote } from "./helpers/members.ts";

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

describe("followingRows", () => {
  const parent = { ownerName: "alice", name: "app", detached: null } as unknown as Repo;
  const at = (state: ForkRelation["state"], behind: number, ahead: number, clean = true) =>
    ({ parent, state, behind, ahead, clean, conflicts: [] }) as unknown as ForkRelation;

  test("a fork behind its parent says by how much, in MCP following's state", () => {
    const rows = followingRows(at("behind", 3, 0), undefined);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("follows alice/app");
    expect(rows[0]!.words).toBe("behind · 0 ahead · 3 behind");
    expect(rows[0]!.repo).toBe(parent);
  });

  test("in step says so; a frozen parent never claims it", () => {
    expect(followingRows(at("synced", 0, 0), undefined)[0]!.words).toBe("in step");
    const frozen = { ...at("synced", 0, 0), parent: { ...parent, detached: { detachedAt: null } } } as ForkRelation;
    expect(followingRows(frozen, undefined)[0]!.words).toBe("parent frozen");
  });

  test("the crew's part is a second line only when there is one", () => {
    const issue = { number: 7 } as Issue;
    const proposed: Converge = { kind: "proposed", issue, pull: { number: 9 } as Pull };
    const rows = followingRows(at("diverged", 2, 1, false), proposed);
    expect(rows.map((r) => r.words)).toEqual(["diverged · 1 ahead · 2 behind", ""]);
    expect(rows[1]!.name).toContain("pull #9");
    expect(followingRows(at("diverged", 2, 1, false), undefined)).toHaveLength(1);
  });


  test("following nothing shows nothing", () => {
    expect(followingRows(undefined, undefined)).toEqual([]);
  });
});

describe("the terminal's forks screen names what the repository follows", () => {
  let dataDir: string;
  let app: App;
  let upstream: Repo;
  const users: Record<string, User> = {};

  const screenOf = async (who: string, owner: string, keys = "", name = "app") => {
    const terminal = headlessTerminal(120, 30);
    const { app: tui, session } = createForgeApp(
      app,
      { sshUsername: who, remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user: users[who]! },
      { terminal, exitHooks: false },
    );
    tui.start();
    tui.ctx.push(forksScreen(session, tui.ctx, getRepo(app.db, owner, name)!));
    await settleApp(tui);
    if (keys !== "") {
      terminal.feed(keys);
      await settleApp(tui);
    }
    const text = tui.screen.toText();
    tui.stop?.();
    return text;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-following-"));
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
    const commit = async (who: string, repo: Repo) =>
      must(
        await commitToBranch(app, users[who]!, repo, {
          message: `${who} ${repo.name}`,
          files: [{ path: `${who}.txt`, content: "x\n" }],
        }),
      );
    upstream = must(await createRepo(app, users["alice"]!, { name: "app", visibility: "public" }));
    await commit("alice", upstream);
    const bob = must(await forkRepo(app, users["bob"]!, upstream));
    const carol = must(await forkRepo(app, users["carol"]!, upstream));
    const dan = must(await forkRepo(app, users["dan"]!, upstream));
    await commit("bob", bob);
    // Dan and alice both write shared.txt: git cannot merge them.
    must(
      await commitToBranch(app, users["dan"]!, dan, {
        message: "dan shared",
        files: [{ path: "shared.txt", content: "dan\n" }],
      }),
    );
    must(
      await commitToBranch(app, users["alice"]!, upstream, {
        message: "alice again",
        files: [
          { path: "again.txt", content: "y\n" },
          { path: "shared.txt", content: "alice\n" },
        ],
      }),
    );
    // A converge issue on both diverged forks: only the conflicting one is the crew's.
    for (const [fork, who] of [[dan, "dan"], [bob, "bob"]] as const)
      must(createIssue(app.db, { repoId: fork.id, authorId: users[who]!.id, title: convergeTitle(upstream) }));
    // A parent the fork's owner can no longer read.
    const hidden = must(await createRepo(app, users["alice"]!, { name: "hidden", visibility: "public" }));
    await commit("alice", hidden);
    must(await forkRepo(app, users["bob"]!, hidden));
    app.db.query("UPDATE repo SET visibility = 'private' WHERE id = ?1").run(hidden.id);
    // Carol has nothing of her own, so her fork follows by itself.
    let synced = false;
    for (let i = 0; i < 100 && !synced; i++) {
      synced = (await forkRelation(app, carol, upstream))?.state === "synced";
      if (!synced) await Bun.sleep(50);
    }
    if (!synced) throw new Error("carol's fork never caught up with its parent");
  }, 60_000);

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a fork behind its parent says so", async () => {
    const text = await screenOf("bob", "bob");
    expect(text).toContain("follows alice/app");
    expect(text).toContain("1 behind");
    expect(text).toContain("1 ahead");
  });

  test("a diverged fork that merges cleanly has no crew line, even with a converge issue open", async () => {
    const text = await screenOf("bob", "bob");
    expect(text).toContain("merges cleanly");
    expect(text).not.toContain("converging");
  });

  test("a conflicting fork says what the crew is doing about it", async () => {
    const text = await screenOf("dan", "dan");
    expect(text).toContain("follows alice/app");
    expect(text).toContain("diverged · 1 ahead · 1 behind");
    expect(text).not.toContain("merges cleanly");
    expect(text).toMatch(/The crew is already converging on #\d+\./);
  });

  test("a fork in step says it is in step", async () => {
    const text = await screenOf("carol", "carol");
    expect(text).toContain("follows alice/app");
    expect(text).toContain("in step");
  });

  test("a repository that follows nothing shows no such line", async () => {
    const text = await screenOf("alice", "alice");
    expect(text).not.toContain("follows ");
    expect(text).toContain("bob/app");
  });

  test("enter on the line opens the original", async () => {
    const text = await screenOf("carol", "carol", "\r");
    expect(text).toContain("alice/app");
    expect(text).not.toContain("follows alice/app");
  });

  test("a parent the viewer cannot read is never named, and enter opens nothing", async () => {
    const before = await screenOf("bob", "bob", "", "hidden");
    expect(before).toContain("bob/hidden");
    expect(before).not.toContain("alice/hidden");
    expect(before).not.toContain("follows ");
    const after = await screenOf("bob", "bob", "\r", "hidden");
    expect(after).toContain("bob/hidden · 0 forks");
    expect(after).toContain("No forks yet");
    expect(after).not.toContain("alice/hidden");
  });
});
