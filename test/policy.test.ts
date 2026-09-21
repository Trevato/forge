/**
 * The wall: a pull that loosens a contract cell toward the floor is a
 * change of policy, shown on the pull and never landed by the crew, however
 * green. Tightening needs nobody.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openPull } from "../src/actions/pulls.ts";
import {
  commitToBranch,
  createRepo,
  updateRepoSettings,
} from "../src/actions/repos.ts";
import { landIfGreen } from "../src/crew/autonomy.ts";
import { getPull } from "../src/core/pulls.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { readContract, type Contract } from "../src/contract/can.ts";
import { loosened, wallOf, wallSentence } from "../src/contract/policy.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { repoDir } from "../src/git/repos.ts";
import { resolveOid } from "../src/git/merge.ts";
import { serve, type Servers } from "../src/http/server.ts";

const NOTES: Contract = {
  roles: {
    anon: { above: [], held: { by: "everyone" } },
    user: { above: ["anon"], held: { by: "identity", role: "user" } },
    author: { above: ["user"], held: { by: "row", column: "author_id" } },
    admin: { above: ["author"], held: { by: "identity", role: "admin" } },
  },
  resources: {
    note: {
      can: {
        create: "user",
        read: "anon",
        update: "author",
        delete: "author",
        list: "anon",
      },
    },
  },
};
const withCan = (
  can: Partial<Contract["resources"][string]["can"]>,
): Contract => ({
  ...NOTES,
  resources: { note: { can: { ...NOTES.resources["note"]!.can, ...can } } },
});

describe("what counts as loosening", () => {
  test("a cell opening toward the floor, and a decided cell opening at all", () => {
    expect(
      loosened(NOTES, withCan({ create: "anon" })).map(wallSentence),
    ).toEqual(["note.create as anon: was no, now yes"]);
    expect(
      loosened(NOTES, withCan({ delete: "user" })).map(wallSentence),
    ).toEqual(["note.delete as user: was own, now yes"]);
  });

  test("tightening, and the same table, loosen nothing", () => {
    expect(loosened(NOTES, withCan({ read: "user", list: "user" }))).toEqual(
      [],
    );
    expect(loosened(NOTES, withCan({ delete: "admin" }))).toEqual([]);
    expect(loosened(NOTES, NOTES)).toEqual([]);
  });

  test("a new resource against a decided table: every open cell is new", () => {
    const more: Contract = {
      ...NOTES,
      resources: {
        ...NOTES.resources,
        tag: {
          can: {
            create: "admin",
            read: "anon",
            update: "admin",
            delete: "admin",
            list: "user",
          },
        },
      },
    };
    const cells = loosened(NOTES, more).map(wallSentence);
    expect(cells).toContain("tag.read as anon: new, and yes");
    expect(cells).toContain("tag.list as user: new, and yes");
    expect(cells).not.toContain("tag.create as anon: new, and yes");
    expect(cells.every((c) => c.startsWith("tag."))).toBe(true);
  });

  test("a first contract: only what the floor may do is a decision", () => {
    expect(loosened(undefined, NOTES).map(wallSentence)).toEqual([
      "note.read as anon: new, and yes",
      "note.list as anon: new, and yes",
    ]);
    const sealed = withCan({ read: "user", list: "user" });
    expect(loosened(undefined, sealed)).toEqual([]);
  });
});

describe("a pull at the wall", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let repo: Repo;
  let dir: string;
  const tip = (branch: string) => resolveOid(dir, `refs/heads/${branch}`);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-wall-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, {
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const made = await createRepo(app, alice, {
      name: "notes",
      visibility: "public",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
    const seeded = await commitToBranch(app, alice, repo, {
      message: "a contract",
      files: [{ path: "contract.json", content: JSON.stringify(NOTES) }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const branchWith = async (branch: string, contract: Contract | string) => {
    const wrote = await commitToBranch(app, alice, repo, {
      branch,
      message: branch,
      files: [
        {
          path: "contract.json",
          content:
            typeof contract === "string" ? contract : JSON.stringify(contract),
        },
      ],
    });
    if (!wrote.ok) throw new Error(JSON.stringify(wrote.error));
  };

  test("a loosening head crosses; a tightening one and an unchanged one do not", async () => {
    const base = (await tip("main"))!;
    await branchWith("open-it", withCan({ create: "anon" }));
    const crossing = await wallOf(dir, base, (await tip("open-it"))!);
    expect(crossing?.loosened.map(wallSentence)).toEqual([
      "note.create as anon: was no, now yes",
    ]);
    await branchWith("close-it", withCan({ read: "user" }));
    expect(await wallOf(dir, base, (await tip("close-it"))!)).toBeUndefined();
    const same = await commitToBranch(app, alice, repo, {
      branch: "readme-only",
      message: "words",
      files: [{ path: "README.md", content: "# notes\n" }],
    });
    expect(same.ok).toBe(true);
    expect(
      await wallOf(dir, base, (await tip("readme-only"))!),
    ).toBeUndefined();
  });

  test("a head whose contract does not read is a wall too", async () => {
    const base = (await tip("main"))!;
    await branchWith("break-it", "{");
    const wall = await wallOf(dir, base, (await tip("break-it"))!);
    expect(wall?.unsound).toEqual(["contract.json is not JSON"]);
  });

  test("the pull page says so, in the same sentences", async () => {
    const opened = await openPull(app, alice, repo, {
      title: "Let anyone add notes",
      baseBranch: "main",
      headBranch: "open-it",
    });
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    const body = await (
      await fetch(`${servers.url}/alice/notes/pulls/${opened.value.number}`)
    ).text();
    expect(body).toContain(
      "This pull changes the policy: one door opens wider.",
    );
    expect(body).toContain("note.create as anon: was no, now yes");
    const quiet = await openPull(app, alice, repo, {
      title: "Only the signed-in read",
      baseBranch: "main",
      headBranch: "close-it",
    });
    if (!quiet.ok) throw new Error(JSON.stringify(quiet.error));
    const other = await (
      await fetch(`${servers.url}/alice/notes/pulls/${quiet.value.number}`)
    ).text();
    expect(other).not.toContain("changes the policy");
    expect(getRepoById(app.db, repo.id)).toBeDefined();
    expect(readContract(JSON.stringify(NOTES)).ok).toBe(true);
  });

  test("the crew never lands a green pull across the wall; a person still can", async () => {
    const on = await updateRepoSettings(app, alice, repo, {
      autonomy: "autonomous",
      autonomyDirection: "Notes for everyone.",
      autonomyCeilingUsd: 10,
      autonomySlots: 1,
      autonomyBy: alice.id,
    });
    expect(on.ok).toBe(true);
    const fresh = () => getRepoById(app.db, repo.id)!;
    const green = (number: number) => {
      const pull = getPull(app.db, repo.id, number)!;
      const check = createRun(app.db, {
        repoId: repo.id,
        kind: "check",
        issueId: pull.id,
        env: `pull-${pull.number}`,
        commitOid: pull.headOid,
        reason: "pull",
      });
      claimRun(app.db, check.id);
      finishRun(app.db, check.id, { state: "ok", summary: "check passed" });
      return pull;
    };
    const opening = await openPull(app, alice, repo, {
      title: "Anyone may add notes",
      baseBranch: "main",
      headBranch: "open-it",
    });
    if (!opening.ok) throw new Error(JSON.stringify(opening.error));
    const closing = await openPull(app, alice, repo, {
      title: "Only the signed-in read",
      baseBranch: "main",
      headBranch: "close-it",
    });
    if (!closing.ok) throw new Error(JSON.stringify(closing.error));

    // Green, autonomous, and still not landed: it crosses the wall.
    const wall = green(opening.value.number);
    expect(await landIfGreen(app, fresh(), wall)).toBe(false);
    expect(await landIfGreen(app, fresh(), wall)).toBe(false);
    expect(getPull(app.db, repo.id, wall.number)!.mergedAt).toBeNull();
    // The same crew lands the tightening one without a word.
    const tight = green(closing.value.number);
    expect(await landIfGreen(app, fresh(), tight)).toBe(true);
    expect(getPull(app.db, repo.id, tight.number)!.mergedAt).not.toBeNull();
  });
});
