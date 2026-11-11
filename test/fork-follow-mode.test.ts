import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setFollowMode } from "../src/actions/follow.ts";
import { commitToBranch, createRepo, forkRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { forkFollowMode } from "../src/core/fork_follow.ts";
import { forkRelation } from "../src/core/following.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import { listEvents } from "../src/core/events.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { forksScreen } from "../src/tui/screens/forks.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";
import { promote } from "./helpers/members.ts";

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

let dataDir: string;
let app: App;
let original: Repo;
let fork: Repo;
const users: Record<string, User> = {};

const row = (id: string) => app.db.query("SELECT mode FROM fork_follow WHERE repo_id = ?1").get(id);
const commit = async (who: string, repo: Repo, path: string) =>
  must(await commitToBranch(app, users[who]!, repo, { message: path, files: [{ path, content: `${path}\n` }] }));

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-fork-follow-mode-"));
  app = createApp({ dataDir, port: 0 });
  for (const name of ["ann", "bea", "cal", "dee", "eve"]) {
    users[name] = must(
      await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username: name,
        email: `${name}@f.dev`,
        password: "a-good-passphrase",
        adminIfFirst: name === "ann",
      }),
    );
    promote(app.db, users[name]!);
  }
  original = must(await createRepo(app, users["ann"]!, { name: "yard", visibility: "public" }));
  await commit("ann", original, "a.txt");
  fork = must(await forkRepo(app, users["bea"]!, original));
}, 60_000);

afterAll(async () => {
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("setFollowMode on a plain fork", () => {
  test("a guest and a stranger are refused and write no row", async () => {
    const guest = await setFollowMode(app, undefined, fork, "take-updates");
    expect(guest).toEqual({ ok: false, error: "unauthorized" });
    const stranger = await setFollowMode(app, users["cal"]!, fork, "take-updates");
    expect(stranger).toEqual({ ok: false, error: "forbidden" });
    expect(row(fork.id)).toBeNull();
    expect(forkFollowMode(app.db, fork.id)).toBe("tell-me");
  });

  test("a non-fork still follows nothing", async () => {
    const r = await setFollowMode(app, users["ann"]!, original, "take-updates");
    expect(r).toEqual({ ok: false, error: "not_following" });
    expect(row(original.id)).toBeNull();
  });

  test("a bad mode is refused; the owner's good one is kept", async () => {
    expect(await setFollowMode(app, users["bea"]!, fork, "nope")).toEqual({ ok: false, error: "invalid_mode" });
    expect(row(fork.id)).toBeNull();
    expect(must(await setFollowMode(app, users["bea"]!, fork, "take-updates"))).toBe("take-updates");
    expect(forkFollowMode(app.db, fork.id)).toBe("take-updates");
    expect(must(await setFollowMode(app, users["bea"]!, fork, "tell-me"))).toBe("tell-me");
    expect(forkFollowMode(app.db, fork.id)).toBe("tell-me");
  });
});

describe("the mode changes what happens when the parent moves", () => {
  const settle = async (f: Repo, state: string) => {
    for (let i = 0; i < 100; i++) {
      if ((await forkRelation(app, f, original))?.state === state) return true;
      await Bun.sleep(50);
    }
    return false;
  };

  test("tell-me leaves a fork with work of its own diverged; take-updates merges it", async () => {
    await commit("bea", fork, "mine.txt");
    await commit("ann", original, "one.txt");
    expect(await settle(fork, "diverged")).toBe(true);
    await Bun.sleep(300);
    expect((await forkRelation(app, fork, original))?.state).toBe("diverged");

    must(await setFollowMode(app, users["bea"]!, fork, "take-updates"));
    await commit("ann", original, "two.txt");
    // A clean merge leaves the fork ahead of a parent it has caught up with.
    expect(await settle(fork, "ahead")).toBe(true);
  });
});

describe("don't follow (#608)", () => {
  const settle = async (f: Repo, state: string) => {
    for (let i = 0; i < 100; i++) {
      if ((await forkRelation(app, f, original))?.state === state) return true;
      await Bun.sleep(50);
    }
    return false;
  };

  test("is a mode the owner may choose and a stranger may not", async () => {
    const own = must(await forkRepo(app, users["cal"]!, original, "yard-alone"));
    expect(await setFollowMode(app, users["bea"]!, own, "dont-follow")).toEqual({ ok: false, error: "forbidden" });
    expect(must(await setFollowMode(app, users["cal"]!, own, "dont-follow"))).toBe("dont-follow");
    expect(forkFollowMode(app.db, own.id)).toBe("dont-follow");
  });

  test("the parent moving neither moves the fork nor tells anyone; tell-me beside it still fast-forwards", async () => {
    const alone = getRepo(app.db, "cal", "yard-alone")!;
    const told = must(await forkRepo(app, users["dee"]!, original, "yard-told"));
    must(await setFollowMode(app, users["dee"]!, told, "tell-me"));
    const diverged = () => listEvents(app.db, { kind: "fork.diverged" }).filter((e) => e.repoId === alone.id).length;
    await commit("cal", alone, "own.txt");
    const before = diverged();
    await commit("ann", original, "three.txt");
    // The tell-me fork, with nothing of its own, catches up on its own.
    // Its fast-forward starts in the same synchronous pass of `follow` that
    // skips a dont-follow fork, and a skipped fork starts no work at all; so
    // once the sibling has settled, the handler is done with this fork too.
    expect(await settle(told, "synced")).toBe(true);
    expect((await forkRelation(app, alone, original))?.state).toBe("diverged");
    expect(diverged()).toBe(before);

    // With nothing of its own it would have been fast-forwarded; it is not.
    const bare = must(await forkRepo(app, users["eve"]!, original, "yard-bare"));
    must(await setFollowMode(app, users["eve"]!, bare, "dont-follow"));
    await commit("ann", original, "four.txt");
    expect(await settle(told, "synced")).toBe(true);
    expect((await forkRelation(app, bare, original))?.state).toBe("behind");
  });
});

describe("the terminal", () => {
  const open = async (who: string, keys: string) => {
    const terminal = headlessTerminal(120, 30);
    const { app: tui, session } = createForgeApp(
      app,
      { sshUsername: who, remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user: users[who]! },
      { terminal, exitHooks: false },
    );
    tui.start();
    tui.ctx.push(forksScreen(session, tui.ctx, getRepo(app.db, "bea", "yard")!));
    await settleApp(tui);
    terminal.feed(keys);
    await settleApp(tui);
    const text = tui.screen.toText();
    tui.stop?.();
    return text;
  };

  test("the owner sees the mode and flips it with m", async () => {
    must(await setFollowMode(app, users["bea"]!, fork, "tell-me"));
    const before = await open("bea", "");
    expect(before).toContain("Proposes updates from");
    expect(before).toContain("follow mode");
    const after = await open("bea", "m");
    expect(after).toContain("Follows ann/yard automatically");
    expect(forkFollowMode(app.db, fork.id)).toBe("take-updates");
  });

  test("someone who cannot write is not offered it, and m does nothing", async () => {
    must(await setFollowMode(app, users["bea"]!, fork, "tell-me"));
    const text = await open("cal", "m");
    expect(text).not.toContain("follow mode");
    expect(forkFollowMode(app.db, fork.id)).toBe("tell-me");
  });
});
