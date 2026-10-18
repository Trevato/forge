/**
 * `enterableApps` is `canEnterApp` for a whole page in a fixed number of
 * reads. It must answer exactly what the per-row rule answers, for every
 * kind of viewer and both readings of `named` — access may not loosen or
 * tighten by being batched.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { setAppMembers } from "../src/core/app_members.ts";
import { addTeamMember, createOrg, createTeam } from "../src/core/orgs.ts";
import {
  canEnterApp,
  enterableApps,
  getRepoById,
  type Repo,
} from "../src/core/repos.ts";
import {
  createUser,
  getUserById,
  getUserByName,
  type User,
} from "../src/core/users.ts";
import { id } from "../src/kernel/id.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("enterableApps answers what canEnterApp answers", () => {
  let dataDir = "";
  let app: App;
  const rows: {
    repo: Repo;
    app: { id: string; access: "public" | "private" };
  }[] = [];
  const viewers: (User | undefined)[] = [];

  const person = async (username: string, admin = false): Promise<User> => {
    const made = await createUser(app.db, {
      origin: "seed",
      username,
      email: `${username}@forge.test`,
      password: "a-long-matrix-passphrase",
      adminIfFirst: admin,
      trusted: true,
    });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-enterable-"));
    app = createApp({ dataDir, port: 0 });
    const admin = await person("mx-admin", true);
    const owner = await person("mx-owner");
    const writer = await person("mx-writer");
    const reader = await person("mx-reader");
    const named = await person("mx-named");
    const suspended = await person("mx-suspended");
    const stranger = await person("mx-stranger");
    await createAgent(app, admin, { username: "crewbot" });
    const org = createOrg(app.db, "mx-guild", owner.id);
    if (!org.ok) throw new Error("org");
    const writers = createTeam(app.db, org.value.id, "writers", "write");
    const readers = createTeam(app.db, org.value.id, "readers", "read");
    if (!writers.ok || !readers.ok) throw new Error("teams");
    addTeamMember(app.db, writers.value, writer.id);
    addTeamMember(app.db, readers.value, reader.id);
    // Personal and organisation repositories, public and private, with apps
    // public and private; the crew agent is on some, a person named on some.
    let n = 0;
    for (const ownerId of [owner.id, org.value.id])
      for (const visibility of ["public", "private"] as const)
        for (const access of ["public", "private"] as const)
          for (const crew of [false, true]) {
            const repoId = id();
            app.db
              .query(
                "INSERT INTO repo (id, owner_id, name, visibility, default_branch) VALUES (?1, ?2, ?3, ?4, 'main')",
              )
              .run(repoId, ownerId, `r${n++}`, visibility);
            const appId = id();
            app.db
              .query(
                "INSERT INTO app (id, repo_id, slug, access, preview_data) VALUES (?1, ?2, ?3, ?4, 'copy')",
              )
              .run(
                appId,
                repoId,
                `a${n}-${appId.slice(-6)}`.toLowerCase(),
                access,
              );
            const repo = getRepoById(app.db, repoId)!;
            if (crew) addToCrew(app, admin, repo, "crewbot");
            if (n % 2 === 0)
              setAppMembers(app.db, appId, [named.id, suspended.id], owner.id);
            rows.push({ repo, app: { id: appId, access } });
          }
    app.db
      .query("UPDATE user SET suspended_at = ?1 WHERE id = ?2")
      .run(new Date().toISOString(), suspended.id);
    viewers.push(
      undefined,
      getUserById(app.db, admin.id),
      owner,
      writer,
      reader,
      named,
      getUserById(app.db, suspended.id),
      stranger,
      getUserByName(app.db, "crewbot"),
    );
  }, 30_000);

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  for (const named of [true, false])
    test(`for every viewer, named: ${named}`, () => {
      for (const viewer of viewers) {
        const batch = enterableApps(app.db, rows, viewer, { named });
        const one = new Set(
          rows
            .filter((r) =>
              canEnterApp(app.db, r.repo, r.app, viewer, { named }),
            )
            .map((r) => r.app.id),
        );
        expect({
          who: viewer?.username ?? "anonymous",
          ids: [...batch].sort(),
        }).toEqual({
          who: viewer?.username ?? "anonymous",
          ids: [...one].sort(),
        });
      }
    });

  test("the matrix is not trivial: someone is refused and someone named gets in", () => {
    const stranger = viewers.find((v) => v?.username === "mx-stranger");
    const named = viewers.find((v) => v?.username === "mx-named");
    const privateApps = rows.filter((r) => r.app.access === "private").length;
    expect(enterableApps(app.db, rows, stranger).size).toBe(
      rows.length - privateApps,
    );
    expect(
      enterableApps(app.db, rows, named, { named: true }).size,
    ).toBeGreaterThan(
      enterableApps(app.db, rows, named, { named: false }).size,
    );
  });
});
