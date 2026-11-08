/**
 * Making an app (core/apps.ts `createApp`): a slug that is not a DNS label
 * is `invalid_slug`, and a repository that already is an app is
 * `already_app` — the first app stays exactly as it was.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp as insertApp, getAppByRepo } from "../src/core/apps.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";

describe("making an app", () => {
  let dataDir: string;
  let app: App;
  let repo: Repo;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-app-create-"));
    app = createApp({ dataDir, port: 0 });
    const u = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!u.ok) throw new Error(u.error);
    const made = await createRepo(app, u.value, {
      name: "shop",
      visibility: "private",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
  });

  afterAll(async () => {
    await app.close?.();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a repository becomes an app with slug shop", () => {
    // A refused slug leaves no row behind.
    for (const slug of ["Shop", "-shop", "a b", ""]) {
      const r = insertApp(app.db, { repoId: repo.id, slug, access: "public" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe("invalid_slug");
    }
    expect(getAppByRepo(app.db, repo.id)).toBeUndefined();

    const r = insertApp(app.db, {
      repoId: repo.id,
      slug: "shop",
      access: "public",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.slug).toBe("shop");
      expect(r.value.repoId).toBe(repo.id);
    }
  });

  test("a second app on the same repository is already_app and the first is unchanged", () => {
    const before = getAppByRepo(app.db, repo.id)!;
    const r = insertApp(app.db, {
      repoId: repo.id,
      slug: "other",
      access: "private",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("already_app");
    expect(getAppByRepo(app.db, repo.id)).toEqual(before);
    expect(before.slug).toBe("shop");
  });
});
