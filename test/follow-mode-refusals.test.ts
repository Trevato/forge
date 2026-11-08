/**
 * Setting how a fork follows its parent (#7093): the fork's admin may choose
 * each known mode and reads it back; an unknown mode, a repository that
 * follows no parent, and a reader are refused, and the mode is unchanged.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setFollowMode } from "../src/actions/follow.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { FOLLOW_MODES, forgeLinkOf } from "../src/spawn/chain.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("setting how a fork follows its parent", () => {
  let dir = "";
  let app: App;
  let admin: User;
  let reader: User;
  let repo: Repo;
  let other: Repo;

  const mode = async () => (await forgeLinkOf(app))?.mode;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-followmode-"));
    app = createApp({ dataDir: join(dir, "kid"), port: 0, host: "kid.test" });
    const user = async (username: string, adminIfFirst: boolean): Promise<User> => {
      const made = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-long-refusal-passphrase",
        adminIfFirst,
      });
      if (!made.ok) throw new Error(made.error);
      return made.value;
    };
    admin = await user("alice", true);
    reader = await user("rita", false);
    const made = await createRepo(app, admin, { name: "app", visibility: "public" });
    const made2 = await createRepo(app, admin, { name: "other", visibility: "public" });
    if (!made.ok || !made2.ok) throw new Error("repo");
    repo = made.value;
    other = made2.value;
    await Bun.write(
      join(app.config.dataDir, "parent.json"),
      JSON.stringify({
        upstream: "http://127.0.0.1:1",
        name: "kid",
        forgeCode: { repo: "alice/app", upstream: "bob/app", mode: "tell-me", tip: "", chain: [] },
      }),
    );
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("the admin sets each known mode and reads it back", async () => {
    for (const m of [...FOLLOW_MODES, FOLLOW_MODES[0]]) {
      const r = await setFollowMode(app, admin, repo, m);
      expect(r).toEqual({ ok: true, value: m });
      expect(await mode()).toBe(m);
    }
  });

  test("an unknown mode is invalid_mode and the mode stays", async () => {
    await setFollowMode(app, admin, repo, "take-updates");
    for (const bad of ["yolo", "", "TAKE-UPDATES", 1, null, undefined, { mode: "tell-me" }]) {
      const r = await setFollowMode(app, admin, repo, bad);
      expect(r.ok ? "ok" : r.error).toBe("invalid_mode");
      expect(await mode()).toBe("take-updates");
    }
  });

  test("a repository that follows no parent is not_following and the mode stays", async () => {
    const r = await setFollowMode(app, admin, other, "tell-me");
    expect(r.ok ? "ok" : r.error).toBe("not_following");
    expect(await mode()).toBe("take-updates");
  });

  test("a reader is forbidden and the mode stays", async () => {
    const r = await setFollowMode(app, reader, repo, "tell-me");
    expect(r.ok ? "ok" : r.error).toBe("forbidden");
    expect(await mode()).toBe("take-updates");
  });

  test("nobody signed in is unauthorized and the mode stays", async () => {
    const r = await setFollowMode(app, undefined, repo, "tell-me");
    expect(r.ok ? "ok" : r.error).toBe("unauthorized");
    expect(await mode()).toBe("take-updates");
  });
});
