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
import { enableApp } from "../src/actions/apps.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openPull } from "../src/actions/pulls.ts";
import {
  commitToBranch,
  createRepo,
  updateRepoSettings,
} from "../src/actions/repos.ts";
import { landIfGreen } from "../src/crew/autonomy.ts";
import { getPull } from "../src/core/pulls.ts";
import {
  latestDecision,
  listDecisions,
  recordDecision,
} from "../src/core/decisions.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { readContract, type Contract } from "../src/contract/can.ts";
import { loosened, wallOf, wallPlain, wallSentence } from "../src/contract/policy.ts";
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

  test("a crossing reads in plain words (#7847)", () => {
    expect(loosened(undefined, NOTES).map(wallPlain)).toEqual([
      "anyone signed out could read note records",
      "anyone signed out could list note records",
    ]);
    expect(loosened(NOTES, withCan({ delete: "user" })).map(wallPlain)).toEqual([
      "any user could delete note records",
    ]);
    // No naive plural, and the own cell says whose.
    expect(
      wallPlain({ resource: "address", verb: "update", as: "user", answer: "own", from: "no", to: "own", floor: false } as never),
    ).toBe("any user could change their own address records");
  });

  test("tightening, and the same table, loosen nothing", () => {
    expect(loosened(NOTES, withCan({ read: "user", list: "user" }))).toEqual(
      [],
    );
    expect(loosened(NOTES, withCan({ delete: "admin" }))).toEqual([]);
    expect(loosened(NOTES, NOTES)).toEqual([]);
  });

  test("a new resource beside a decided table: only what it opens to the floor", () => {
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
    expect(loosened(NOTES, more).map(wallSentence)).toEqual([
      "tag.read as anon: new, and yes",
    ]);
    // The decided resource is untouched, so nothing else is said.
    const sealed: Contract = {
      ...NOTES,
      resources: {
        ...NOTES.resources,
        tag: {
          can: {
            create: "admin",
            read: "user",
            update: "admin",
            delete: "admin",
            list: "user",
          },
        },
      },
    };
    expect(loosened(NOTES, sealed)).toEqual([]);
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

/**
 * A forge of its own with alice, her public repo `notes` holding NOTES, and
 * the branches the tests read, made once. Landing a pull moves main, so a
 * test that lands asks for a world of its own.
 */
const wallWorld = () => {
  const w = {} as {
    app: App;
    servers: Servers;
    alice: User;
    repo: Repo;
    dir: string;
    tip: (branch: string) => Promise<string | undefined>;
    branchWith: (branch: string, contract: Contract | string) => Promise<void>;
  };
  let dataDir: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-wall-"));
    const app = createApp({ dataDir, port: 0 });
    w.app = app;
    w.servers = await serve(app);
    const a = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    const alice = a.value;
    w.alice = alice;
    const made = await createRepo(app, alice, {
      name: "notes",
      visibility: "public",
    });
    if (!made.ok) throw new Error(String(made.error));
    const repo = made.value;
    w.repo = repo;
    w.dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
    w.tip = (branch) => resolveOid(w.dir, `refs/heads/${branch}`);
    w.branchWith = async (branch, contract) => {
      const wrote = await commitToBranch(app, alice, repo, {
        branch,
        message: branch,
        files: [
          {
            path: "contract.json",
            content:
              typeof contract === "string"
                ? contract
                : JSON.stringify(contract),
          },
        ],
      });
      if (!wrote.ok) throw new Error(JSON.stringify(wrote.error));
    };
    const seeded = await commitToBranch(app, alice, repo, {
      message: "a contract",
      files: [{ path: "contract.json", content: JSON.stringify(NOTES) }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    await w.branchWith("open-it", withCan({ create: "anon" }));
    await w.branchWith("close-it", withCan({ read: "user" }));
  }, 30_000);

  afterAll(async () => {
    w.servers.stop();
    w.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  return w;
};

describe("a pull at the wall", () => {
  const w = wallWorld();

  test("a loosening head crosses; a tightening one and an unchanged one do not", async () => {
    const base = (await w.tip("main"))!;
    const crossing = await wallOf(w.dir, base, (await w.tip("open-it"))!);
    expect(crossing?.loosened.map(wallSentence)).toEqual([
      "note.create as anon: was no, now yes",
    ]);
    expect(
      await wallOf(w.dir, base, (await w.tip("close-it"))!),
    ).toBeUndefined();
    const same = await commitToBranch(w.app, w.alice, w.repo, {
      branch: "readme-only",
      message: "words",
      files: [{ path: "README.md", content: "# notes\n" }],
    });
    expect(same.ok).toBe(true);
    expect(
      await wallOf(w.dir, base, (await w.tip("readme-only"))!),
    ).toBeUndefined();
  });

  test("a head whose contract does not read is a wall too", async () => {
    const base = (await w.tip("main"))!;
    await w.branchWith("break-it", "{");
    const wall = await wallOf(w.dir, base, (await w.tip("break-it"))!);
    expect(wall?.unsound).toEqual(["contract.json is not JSON"]);
  });

  test("the pull page says so, in the same sentences", async () => {
    const opened = await openPull(w.app, w.alice, w.repo, {
      title: "Let anyone add notes",
      baseBranch: "main",
      headBranch: "open-it",
    });
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    const body = await (
      await fetch(`${w.servers.url}/alice/notes/pulls/${opened.value.number}`)
    ).text();
    expect(body).toContain(
      "This pull changes the policy: one door opens wider.",
    );
    expect(body).toContain("note.create as anon: was no, now yes");
    // The wall is §5's card, its headline in the head: no merge-* class.
    expect(body).not.toMatch(/\b(?:merge-(?:box|form|headline|sub)|wall-cells)\b/);
    expect(body).toMatch(
      /<div class="card-head">[\s\S]*?<strong\s*>This pull changes the policy: one door opens wider\.<\/strong/,
    );
    expect(body).toContain("A cell loosened is a decision undone");
    const quiet = await openPull(w.app, w.alice, w.repo, {
      title: "Only the signed-in read",
      baseBranch: "main",
      headBranch: "close-it",
    });
    if (!quiet.ok) throw new Error(JSON.stringify(quiet.error));
    const other = await (
      await fetch(`${w.servers.url}/alice/notes/pulls/${quiet.value.number}`)
    ).text();
    expect(other).not.toContain("changes the policy");
    expect(getRepoById(w.app.db, w.repo.id)).toBeDefined();
    expect(readContract(JSON.stringify(NOTES)).ok).toBe(true);
  });
});

describe("a pull landed at the wall", () => {
  const w = wallWorld();

  test("the crew never lands a green pull across the wall; a person still can", async () => {
    const on = await updateRepoSettings(w.app, w.alice, w.repo, {
      autonomy: "autonomous",
      autonomyDirection: "Notes for everyone.",
      autonomyCeilingUsd: 10,
      autonomySlots: 1,
      autonomyBy: w.alice.id,
    });
    expect(on.ok).toBe(true);
    const fresh = () => getRepoById(w.app.db, w.repo.id)!;
    const green = (number: number) => {
      const pull = getPull(w.app.db, w.repo.id, number)!;
      const check = createRun(w.app.db, {
        repoId: w.repo.id,
        kind: "check",
        issueId: pull.id,
        env: `pull-${pull.number}`,
        commitOid: pull.headOid,
        reason: "pull",
      });
      claimRun(w.app.db, check.id);
      finishRun(w.app.db, check.id, { state: "ok", summary: "check passed" });
      return pull;
    };
    // The wall is about apps, and about the crew's own pulls.
    expect(enableApp(w.app, w.alice, w.repo).ok).toBe(true);
    const made = await createAgent(w.app, w.alice, {
      username: "bot",
      brief: "Be brief.",
    });
    if (!made.ok) throw new Error(String(made.error));
    expect(addToCrew(w.app, w.alice, w.repo, "bot").ok).toBe(true);
    const opening = await openPull(w.app, made.value.user, w.repo, {
      title: "Anyone may add notes",
      baseBranch: "main",
      headBranch: "open-it",
    });
    if (!opening.ok) throw new Error(JSON.stringify(opening.error));
    const closing = await openPull(w.app, w.alice, w.repo, {
      title: "Only the signed-in read",
      baseBranch: "main",
      headBranch: "close-it",
    });
    if (!closing.ok) throw new Error(JSON.stringify(closing.error));

    // Green, autonomous, and still not landed: it crosses the wall.
    const wall = green(opening.value.number);
    expect(await landIfGreen(w.app, fresh(), wall)).toBe(false);
    expect(await landIfGreen(w.app, fresh(), wall)).toBe(false);
    expect(getPull(w.app.db, w.repo.id, wall.number)!.mergedAt).toBeNull();
    // Once, as a ledger row, which is what the pull and the audit read
    // the decider never leans on.
    const row = latestDecision(w.app.db, wall.id, "land");
    expect(row?.answer).toBe("wall");
    expect(row?.by).toBe("wall");
    expect((row?.state as { cells: string[] }).cells).toEqual([
      "note.create as anon: was no, now yes",
    ]);
    // The same head asked again writes nothing new; a row whose cells no
    // longer match what the wall says is superseded, not repeated.
    const rows = () =>
      listDecisions(w.app.db, w.repo.id, { kind: "land" }).filter(
        (d) => d.issueId === wall.id && d.answer === "wall",
      );
    expect(rows()).toHaveLength(1);
    recordDecision(w.app.db, {
      kind: "land",
      repoId: w.repo.id,
      issueId: wall.id,
      state: { head: wall.headOid, cells: ["stale: from an older rule"] },
      answer: "wall",
      p: 1,
      by: "wall",
      ms: 0,
    });
    expect(await landIfGreen(w.app, fresh(), wall)).toBe(false);
    expect(rows()).toHaveLength(3);
    expect((rows()[0]!.state as { cells: string[] }).cells).toEqual([
      "note.create as anon: was no, now yes",
    ]);
    const signedIn = await fetch(`${w.servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({
        username: "alice",
        password: "a-good-passphrase",
      }),
      redirect: "manual",
    });
    const cookie = (signedIn.headers.get("set-cookie") ?? "").split(";")[0]!;
    // A person may still land it by hand, signed in.
    expect(cookie).not.toBe("");
    // The same crew lands the tightening one without a word.
    const tight = green(closing.value.number);
    expect(await landIfGreen(w.app, fresh(), tight)).toBe(true);
    expect(getPull(w.app.db, w.repo.id, tight.number)!.mergedAt).not.toBeNull();
  });
});
