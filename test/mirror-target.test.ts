/**
 * Stopping a mirror (#3408): only the repository's admin can, anyone else is
 * told not found, and the target stays until then.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stopMirroring } from "../src/actions/mirror_target.ts";
import { createApp, type App } from "../src/app.ts";
import { getMirrorTarget, setMirrorTarget } from "../src/core/migrate_mirror.ts";
import { addTeamMember, createOrg, createTeam } from "../src/core/orgs.ts";
import { createRepo, type Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";

describe("stopping a mirror", () => {
  let dataDir: string;
  let app: App;
  let repo: Repo;
  let siteAdmin: User;
  let admin: User;
  let writer: User;
  let stranger: User;

  const person = async (username: string, adminIfFirst = false): Promise<User> => {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      adminIfFirst,
      username,
      email: `${username}@forge.test`,
      password: "mirrors-are-one-way",
    });
    if (!made.ok) throw new Error(String(made.error));
    return made.value;
  };

  const target = () => getMirrorTarget(app.db, repo.id);
  const arm = () => {
    app.db.run("PRAGMA foreign_keys = OFF");
    setMirrorTarget(app.db, {
      repoId: repo.id,
      originId: "origin-none",
      fullName: "octo/gizmo",
      cloneUrl: "https://example.test/octo/gizmo.git",
      tips: {},
    });
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mirror-target-"));
    app = createApp({ dataDir, port: 0 });
    // The first account is the site admin; none of the actors below is it.
    siteAdmin = await person("siteowner", true);
    admin = await person("alice");
    writer = await person("bob");
    stranger = await person("carol");
    const org = createOrg(app.db, "acme", admin.id);
    if (!org.ok) throw new Error(org.error);
    const team = createTeam(app.db, org.value.id, "Writers", "write");
    if (!team.ok) throw new Error(team.error);
    addTeamMember(app.db, team.value, writer.id);
    const made = await createRepo(app.db, app.reposRoot, {
      ownerId: org.value.id,
      name: "gizmo",
      visibility: "private",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    arm();
  });

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  test("a writer who is not admin, a stranger and a guest are told not found, and the target stays", () => {
    for (const actor of [writer, stranger, undefined]) {
      const answer = stopMirroring(app, actor, repo);
      expect(answer.ok).toBe(false);
      if (!answer.ok) expect(answer.error).toBe("not_found");
      expect(target()?.fullName).toBe("octo/gizmo");
    }
  });

  test("the admin stops it: the target is gone, and a second stop answers false", () => {
    expect(stopMirroring(app, admin, repo)).toEqual({ ok: true, value: true });
    expect(target()).toBeUndefined();
    expect(stopMirroring(app, admin, repo)).toEqual({ ok: true, value: false });
  });

  test("the site admin may stop it too", () => {
    arm();
    expect(stopMirroring(app, siteAdmin, repo)).toEqual({ ok: true, value: true });
    expect(target()).toBeUndefined();
  });
});
